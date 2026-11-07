// Kernel process management for dsh-bsb-ipynb.
//
// One python/bridge.py process per notebook path. The bridge speaks JSON
// lines over stdio and owns the real Jupyter kernel, so this file only does
// process lifetime, FIFO bookkeeping and event fan-out.

import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { ApiError } from './json.js'

const READY_TIMEOUT_MS = 30_000
const SHUTDOWN_GRACE_MS = 2_000
const STDERR_TAIL_BYTES = 8 * 1024
const MAX_LINE_BYTES = 64 * 1024 * 1024
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000

const EXECUTION_EVENTS = new Set([
  'stream',
  'display_data',
  'update_display_data',
  'execute_result',
  'error',
  'clear_output',
])

export function exceedsMaxLineBytes(bytes) {
  return bytes > MAX_LINE_BYTES
}

function idleTtlMs() {
  const configured = Number(process.env.DSH_IPYNB_KERNEL_IDLE_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_IDLE_TTL_MS
}

class KernelEntry {
  constructor(manager, target, python) {
    this.manager = manager
    this.target = target
    this.python = python
    this.proc = null
    this.busy = false
    this.ready = false
    this.executionState = 'starting'
    this.lastError = null
    this.lastActivity = Date.now()
    this.currentRun = null
    this.startPromise = null
    this.restartPromise = null
    this.generation = 0
    this.readyResolve = null
    this.readyReject = null
    this.readyTimer = null
    // Restart requests carry an operation id; only the ready event echoing it
    // completes the wait (a bridge-initiated restart can emit its own ready).
    this.readyOpId = null
    // Specific readiness failure (timeout/startup) preserved across the exit
    // event that follows, so /status keeps the actionable cause.
    this.readyFailure = null
    this.stderrTail = ''
    this.stdoutBuffer = ''
    this.stdoutBytes = 0
    this.stdoutScanIndex = 0
    this.stopping = false
    // Host-chosen path so the file can be removed even after a hard kill.
    this.connectionFile = null
  }

  ensureStarted() {
    if (this.stopping) {
      return Promise.reject(new ApiError('kernel-unavailable', 503, 'Kernel is shutting down'))
    }
    if (this.restartPromise) return this.restartPromise
    if (this.ready && this.proc) return Promise.resolve()
    if (this.startPromise) return this.startPromise
    this.startPromise = this.start().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  start() {
    this.ready = false
    this.executionState = 'starting'
    this.lastError = null
    this.stopping = false
    this.stderrTail = ''
    this.stdoutBuffer = ''
    this.stdoutBytes = 0
    this.stdoutScanIndex = 0
    const python = this.python
    const bridge = this.manager.bridgePath
    const dir = path.dirname(this.target)
    // The host owns the connection file path: on Windows the bridge can be
    // killed with TerminateProcess, which would otherwise leave jupyter_client's
    // own %TEMP%\tmp*.json behind.
    const connectionFile = path.join(
      os.tmpdir(),
      `dsh-bsb-ipynb-kernel-${process.pid}-${randomUUID()}.json`,
    )
    let proc
    try {
      proc = spawn(python, ['-u', bridge, '--cwd', dir, '--connection-file', connectionFile], {
        cwd: dir,
        env: {
          ...process.env,
          DSH_IPYNB_KERNEL_CWD: dir,
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw new ApiError('kernel-unavailable', 503, `Failed to start Python: ${error.message}`)
    }
    this.proc = proc
    this.connectionFile = connectionFile
    // A failed bridge can still deliver buffered data/errors or exit after a
    // retry replaces it. Keep every callback bound to its originating process.
    const isCurrentProcess = () => this.proc === proc
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    if (proc.stdin) {
      // A write can fail asynchronously (EPIPE when the bridge dies between our
      // write and its read). Without this listener Node turns that into an
      // uncaughtException and can take the whole DSH host down.
      proc.stdin.on('error', (error) => {
        if (isCurrentProcess()) this.handleStdinError(error)
      })
    }
    proc.stdout.on('data', (chunk) => {
      if (isCurrentProcess()) this.handleStdout(chunk)
    })
    proc.stderr.on('data', (chunk) => {
      if (!isCurrentProcess()) return
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
    })
    proc.on('error', (error) => {
      if (!isCurrentProcess()) return
      const message = `Failed to start Python: ${error.message}`
      // Node never emits 'exit' for a process that could not be spawned
      // (ENOENT/EACCES/EMFILE...). Clear the dead handle here so the entry is
      // forgotten instead of reporting running:true forever.
      if (proc.pid === undefined) {
        this.proc = null
        this.cleanupConnectionFile()
        this.failReady(message)
        this.manager.forget(this.target, this)
        return
      }
      this.failReady(message)
    })
    proc.on('exit', (code, signal) => {
      if (isCurrentProcess()) this.handleExit(code, signal)
    })

    return this.beginReadyWait('become ready')
  }

  // Shared by start() and restart(): wait for the bridge's next "ready" event.
  // A restart passes the operation id its ready event must echo.
  beginReadyWait(label, opId = null) {
    const proc = this.proc
    this.readyOpId = opId
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      const timer = setTimeout(() => {
        // Restarts reuse the same bridge, so check the wait as well as the
        // process. An already queued old timeout must not fail a newer wait.
        if (this.proc !== proc || this.readyTimer !== timer) return
        const tail = this.stderrTail.trim().slice(-2000)
        const suffix = tail ? ` Python reported: ${tail}` : ' No output was produced.'
        this.failReady(`Python kernel did not ${label} within 30 seconds.${suffix}`)
      }, READY_TIMEOUT_MS)
      this.readyTimer = timer
      if (this.readyTimer.unref) this.readyTimer.unref()
    })
  }

  rejectReadyWait(message) {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    this.readyOpId = null
    const reject = this.readyReject
    this.readyReject = null
    this.readyResolve = null
    if (reject) reject(new ApiError('kernel-unavailable', 503, message))
  }

  failReady(message) {
    this.rejectReadyWait(message)
    if (this.proc) this.kill()
    this.ready = false
    this.executionState = 'dead'
    this.lastError = message
    this.readyFailure = message
    this.failRun(message)
  }

  finishReady(event) {
    const opId = event && typeof event.op_id === 'number' ? event.op_id : null
    if (this.readyOpId !== null) {
      // Only the ready event echoing the restart operation completes the wait.
      if (opId !== this.readyOpId) {
        this.lastActivity = Date.now()
        return
      }
    } else {
      if (opId !== null) {
        this.lastActivity = Date.now()
        return
      }
      if (!this.readyResolve) {
        // The bridge restarted on its own (interrupt timeout) and no host
        // waiter is interested. Record readiness without clobbering the
        // execution state of a run that is about to be settled.
        this.ready = true
        this.lastError = null
        this.readyFailure = null
        this.lastActivity = Date.now()
        return
      }
    }
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    this.readyOpId = null
    this.ready = true
    this.lastError = null
    this.readyFailure = null
    this.executionState = 'idle'
    const resolve = this.readyResolve
    this.readyResolve = null
    this.readyReject = null
    if (resolve) resolve()
  }

  settleRun(run, event) {
    if (!run || run.settled) return
    run.settled = true
    if (this.currentRun === run) this.currentRun = null
    this.busy = false
    run.resolve(event)
  }

  failRun(message) {
    const run = this.currentRun
    if (!run) {
      this.busy = false
      return
    }
    if (run.listener) {
      try {
        run.listener({
          type: 'error',
          cell_id: run.cellId,
          exec_id: run.execId,
          ename: 'KernelError',
          evalue: message,
          traceback: [],
        })
      } catch {
        // A dead HTTP response must never take the kernel down.
      }
    }
    this.settleRun(run, {
      type: 'execute_reply',
      cell_id: run.cellId,
      exec_id: run.execId,
      ok: false,
      execution_count: null,
      status: 'error',
      error: message,
    })
  }

  dispatch(event) {
    const run = this.currentRun
    if (!run || !run.listener) return
    const cellId = event.cell_id
    if (cellId !== undefined && cellId !== null && cellId !== run.cellId) return
    try {
      run.listener(event)
    } catch {
      // A dead HTTP response must never take the kernel down.
    }
  }

  matchesRun(run, event) {
    if (run.cellId !== event.cell_id) return false
    if (typeof event.exec_id === 'string' && event.exec_id !== run.execId) return false
    return true
  }

  emit(event) {
    const run = this.currentRun
    const hasExecId = typeof event.exec_id === 'string'
    // A run can observe its old client dying while a restart is replacing it.
    // That execution-scoped event must not kill the replacement. Untagged
    // notifications still describe the whole kernel and remain fatal.
    if (event.type === 'kernel_died' && hasExecId && (!run || !this.matchesRun(run, event))) return
    this.lastActivity = Date.now()
    if (event.type === 'status') {
      if (hasExecId && (!run || event.exec_id !== run.execId)) return
      // A stale idle from a superseded execution must not clobber the state of
      // the run that is currently in flight.
      if (!this.busy) this.executionState = event.execution_state || this.executionState
      this.dispatch(event)
      return
    }
    if (event.type === 'execute_reply') {
      // A late reply from a superseded run must never settle the new run and
      // must not flip the kernel back to idle either.
      if (!run || !this.matchesRun(run, event)) return
      this.executionState = 'idle'
      this.dispatch(event)
      this.settleRun(run, event)
      return
    }
    if (event.type === 'kernel_died') {
      this.lastError = event.message || 'Kernel process exited'
      this.ready = false
      this.busy = false
      this.dispatch(event)
      this.failRun(this.lastError)
      // Do not leave the bridge alive as a zombie after its kernel died: it
      // cannot serve a new execute and the manager must be able to forget it.
      this.kill()
      return
    }
    if (hasExecId && EXECUTION_EVENTS.has(event.type) && (!run || event.exec_id !== run.execId)) return
    this.dispatch(event)
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk
    // stdout is decoded as utf8; count UTF-8 bytes (not JS UTF-16 code units)
    // so the cap really is MAX_LINE_BYTES on the wire.
    this.stdoutBytes += Buffer.byteLength(chunk)
    if (exceedsMaxLineBytes(this.stdoutBytes)) {
      const message = 'Kernel output line exceeded 64 MiB; execution aborted and kernel restarted'
      this.stdoutBuffer = ''
      this.stdoutBytes = 0
      this.stdoutScanIndex = 0
      this.lastError = message
      // Several chunks of the same flood can arrive while the restart is
      // already in flight; only react once.
      if (this.restartPromise) return
      const run = this.currentRun
      if (run) {
        this.dispatch({ type: 'fatal', code: 'too-large', message, cell_id: run.cellId, exec_id: run.execId })
      }
      this.failRun(message)
      // The kernel is still producing the line, so restart it to stop the flood.
      if (this.proc) void this.restart().catch(() => {})
      return
    }
    let index = this.stdoutBuffer.indexOf('\n', this.stdoutScanIndex)
    while (index !== -1) {
      const raw = this.stdoutBuffer.slice(0, index)
      const line = raw.trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      this.stdoutBytes -= Buffer.byteLength(raw) + 1
      if (line) this.handleLine(line)
      index = this.stdoutBuffer.indexOf('\n')
    }
    this.stdoutScanIndex = this.stdoutBuffer.length
  }

  handleLine(line) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      // While restarting, the buffer can still hold the tail of the oversized
      // line that triggered the restart; never overwrite its real cause.
      if (!this.restartPromise && this.ready) {
        this.lastError = `Unreadable kernel event: ${line.slice(0, 200)}`
      }
      return
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return
    if (event.type === 'ready') {
      this.finishReady(event)
    }
    if (event.type === 'status_reply') {
      this.dispatch(event)
      return
    }
    this.emit(event)
  }

  handleExit(code, signal) {
    const wasStopping = this.stopping
    this.cleanupConnectionFile()
    // The stderr tail is the only clue a crashed bridge leaves behind; stale
    // lastError values (e.g. one unreadable event) must not mask the real cause.
    const stderrTail = this.stderrTail.trim().slice(-2000)
    // A readiness failure carries the actionable cause (e.g. the Python
    // traceback of a failed startup); the generic exit line must not hide it.
    const readyFailure = this.readyFailure
    this.readyFailure = null
    this.proc = null
    this.ready = false
    this.executionState = 'dead'
    const base = `Kernel process exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'none'})`
    const reason = wasStopping
      ? 'Kernel stopped'
      : readyFailure
        ? `${readyFailure}. ${base}`
        : stderrTail
          ? `${base}. Python reported: ${stderrTail}`
          : base
    this.lastError = reason
    // Settle any accepted execution on every exit path, including shutdown,
    // so an HTTP NDJSON stream can never wait forever.
    if (!wasStopping) this.emit({ type: 'kernel_died', message: reason })
    else this.failRun(reason)
    if (!wasStopping) this.failReady(reason)
    else this.rejectReadyWait(reason)
    this.manager.forget(this.target, this)
  }

  handleStdinError(error) {
    const message = `Failed to talk to the kernel: ${error.message}`
    this.lastError = message
    this.ready = false
    this.executionState = 'dead'
    this.failRun(message)
    if (!this.stopping && this.readyReject) this.failReady(message)
    else if (this.readyReject) this.rejectReadyWait(message)
    this.kill()
  }

  write(command) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new ApiError('kernel-unavailable', 503, 'Kernel process is not running')
    }
    try {
      this.proc.stdin.write(`${JSON.stringify(command)}\n`)
    } catch (error) {
      const message = `Failed to talk to the kernel: ${error.message}`
      this.lastError = message
      this.failRun(message)
      throw new ApiError('kernel-unavailable', 503, message)
    }
  }

  async run(cellId, code, onEvent, { signal } = {}) {
    signal?.throwIfAborted()
    if (this.stopping) {
      throw new ApiError('kernel-unavailable', 503, 'Kernel is shutting down')
    }
    if (this.busy || this.currentRun) {
      throw new ApiError('kernel-busy', 409, 'The kernel is already executing a cell')
    }
    if (!this.proc) {
      throw new ApiError('kernel-unavailable', 503, 'Kernel is not running')
    }
    if (!this.ready || this.restartPromise) {
      // A restart (or first start) is in flight: wait for it instead of
      // sending a cell to a bridge that is tearing its channels down.
      const pending = this.restartPromise || this.startPromise
      if (!pending) {
        throw new ApiError('kernel-unavailable', 503, 'Kernel is not ready')
      }
      await pending
      // A disconnected caller can be waiting here for a restart. Interrupting
      // the bridge cannot cancel code that has not been submitted yet.
      signal?.throwIfAborted()
      if (this.stopping) {
        throw new ApiError('kernel-unavailable', 503, 'Kernel is shutting down')
      }
      if (this.busy || this.currentRun) {
        throw new ApiError('kernel-busy', 409, 'The kernel is already executing a cell')
      }
      if (!this.proc || !this.ready) {
        throw new ApiError('kernel-unavailable', 503, 'Kernel is not ready')
      }
    }
    const execId = randomUUID()
    const run = {
      cellId,
      execId,
      listener: typeof onEvent === 'function' ? onEvent : null,
      resolve: null,
      settled: false,
    }
    const result = new Promise((resolve) => {
      run.resolve = resolve
    })
    this.currentRun = run
    this.busy = true
    this.executionState = 'busy'
    this.lastActivity = Date.now()
    try {
      this.write({ op: 'execute', cell_id: cellId, exec_id: execId, code })
    } catch (error) {
      // A failed write must not leave a phantom busy kernel behind: the caller
      // gets the error and the next request is allowed to try again.
      this.currentRun = null
      this.busy = false
      this.executionState = 'dead'
      throw error
    }
    return result
  }

  async interrupt() {
    if (!this.proc) throw new ApiError('kernel-unavailable', 503, 'Kernel is not running')
    this.write({ op: 'interrupt' })
  }

  restart() {
    if (this.stopping) {
      return Promise.reject(new ApiError('kernel-unavailable', 503, 'Kernel is shutting down'))
    }
    // Publish the shared operation before awaiting startup or notifying run
    // listeners, either of which can allow another restart request to arrive.
    if (this.restartPromise) return this.restartPromise
    let resolveWait
    let rejectWait
    const wait = new Promise((resolve, reject) => {
      resolveWait = resolve
      rejectWait = reject
    })
    wait.then(
      () => {
        if (this.restartPromise === wait) this.restartPromise = null
      },
      () => {
        if (this.restartPromise === wait) this.restartPromise = null
      },
    )
    this.restartPromise = wait
    // Call directly: for an already-started kernel, ready must become false
    // synchronously so restart(); run() cannot submit to the old kernel.
    this.restartAfterStartup().then(resolveWait, rejectWait)
    return wait
  }

  async restartAfterStartup() {
    // A failed start must reject all restart callers too, rather than sending
    // commands to a failed process whose exit callback has not arrived yet.
    if (this.startPromise) await this.startPromise
    if (this.stopping) {
      throw new ApiError('kernel-unavailable', 503, 'Kernel is shutting down')
    }
    if (!this.proc || !this.ready) {
      throw new ApiError('kernel-unavailable', 503, 'Kernel is not ready')
    }
    // The bridge does not answer the interrupted cell's shell request on every
    // jupyter_client/kernel combination, so settle it here instead of leaving
    // the HTTP stream (and the client's run-all loop) pending forever.
    this.failRun('Kernel restarted before the cell finished')
    this.generation += 1
    const opId = this.generation
    this.ready = false
    this.executionState = 'starting'
    // finishReady()/failReady() fulfill this through readyResolve/readyReject.
    // Reporting the restart as done before the matching 'ready' would let the
    // next execute race the bridge teardown and lose its reply.
    const ready = this.beginReadyWait('restart', opId)
    try {
      this.write({ op: 'restart', id: opId })
    } catch (error) {
      this.failReady(`Failed to restart the kernel: ${error.message}`)
    }
    await ready
  }

  async shutdown() {
    this.stopping = true
    this.failRun('Kernel shut down before the cell finished')
    this.rejectReadyWait('Kernel shut down before it became ready')
    this.ready = false
    const proc = this.proc
    if (!proc) {
      this.manager.forget(this.target, this)
      return
    }
    try {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`)
        proc.stdin.end()
      }
    } catch {
      // Fall through to signals.
    }
    const exited = new Promise((resolve) => {
      if (proc.exitCode !== null || !this.proc) return resolve()
      proc.once('exit', () => resolve())
    })
    const timer = setTimeout(() => {
      this.kill(proc)
    }, SHUTDOWN_GRACE_MS)
    if (timer.unref) timer.unref()
    let graceTimer
    const grace = new Promise((resolve) => {
      graceTimer = setTimeout(resolve, SHUTDOWN_GRACE_MS + 500)
      if (graceTimer.unref) graceTimer.unref()
    })
    await Promise.race([exited, grace])
    clearTimeout(timer)
    clearTimeout(graceTimer)
    this.manager.forget(this.target, this)
  }

  // The connection file is host-chosen; remove it on every exit path, including
  // a TerminateProcess that prevented the bridge from cleaning up after itself.
  cleanupConnectionFile() {
    const file = this.connectionFile
    this.connectionFile = null
    if (!file) return
    void fsp.unlink(file).catch(() => {})
  }

  kill(proc = this.proc) {
    if (!proc) return
    try {
      proc.kill('SIGTERM')
    } catch {
      // Ignore.
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // Ignore.
      }
    }, 2_000)
    if (timer.unref) timer.unref()
  }

  status() {
    return {
      running: Boolean(this.proc),
      ready: this.ready,
      busy: this.busy,
      python: this.python,
      executionState: this.executionState,
      lastError: this.lastError,
    }
  }
}

export class KernelManager {
  constructor(ctx, bridgePath) {
    this.ctx = ctx
    this.bridgePath = bridgePath
    this.entries = new Map()
    this.starting = new Map()
    this.disposed = false
    this.timer = setInterval(() => {
      void this.sweepIdle().catch((error) => {
        console.error('[dsh-bsb-ipynb] kernel idle sweep failed:', error)
      })
    }, 60_000)
    if (this.timer.unref) this.timer.unref()
  }

  throwIfDisposed() {
    if (this.disposed) {
      throw new ApiError('kernel-unavailable', 503, 'Kernel manager is disposed')
    }
  }

  async getOrStart(target, python) {
    this.throwIfDisposed()
    // Two requests can arrive before the first kernel finishes starting.
    // Serialize creation per notebook so both get the same entry instead of
    // spawning (and leaking) a second bridge process.
    const pending = this.starting.get(target)
    if (pending) {
      await pending
      return this.getOrStart(target, python)
    }
    const promise = this.startEntry(target, python)
    this.starting.set(target, promise)
    try {
      return await promise
    } finally {
      if (this.starting.get(target) === promise) this.starting.delete(target)
    }
  }

  async startEntry(target, python) {
    this.throwIfDisposed()
    let entry = this.entries.get(target)
    if (entry && entry.python !== python) {
      if (entry.busy) {
        throw new ApiError('kernel-busy', 409, 'Restart the kernel before switching interpreters')
      }
      await entry.shutdown()
      this.throwIfDisposed()
      if (this.entries.get(target) === entry) this.entries.delete(target)
      entry = undefined
    }
    if (!entry) {
      entry = new KernelEntry(this, target, python)
      this.entries.set(target, entry)
    }
    await entry.ensureStarted()
    if (this.disposed) {
      // disposeAll() waits for this start operation, so this late completion
      // cannot leave a live entry behind after disposal has returned.
      await entry.shutdown()
      this.throwIfDisposed()
    }
    entry.lastActivity = Date.now()
    return entry
  }

  peek(target) {
    return this.entries.get(target) || null
  }

  status(target) {
    const entry = this.entries.get(target)
    if (!entry) {
      return {
        running: false,
        ready: false,
        busy: false,
        python: null,
        executionState: 'none',
        lastError: null,
      }
    }
    return entry.status()
  }

  forget(target, entry = this.entries.get(target)) {
    if (entry && this.entries.get(target) === entry && !entry.proc) this.entries.delete(target)
  }

  async interrupt(target) {
    const entry = this.entries.get(target)
    if (!entry) throw new ApiError('kernel-unavailable', 503, 'No kernel is running for this notebook')
    await entry.interrupt()
    return entry
  }

  get kernelCount() {
    return this.entries.size
  }

  async restart(target) {
    const entry = this.entries.get(target)
    if (!entry) throw new ApiError('kernel-unavailable', 503, 'No kernel is running for this notebook')
    await entry.restart()
    return entry
  }

  async shutdown(target) {
    const entry = this.entries.get(target)
    if (!entry) return false
    await entry.shutdown()
    if (this.entries.get(target) === entry) this.entries.delete(target)
    return true
  }

  async sweepIdle() {
    const ttl = idleTtlMs()
    const now = Date.now()
    for (const [target, entry] of this.entries) {
      if (entry.busy || entry.startPromise || entry.restartPromise || entry.stopping) continue
      if (now - entry.lastActivity < ttl) continue
      await entry.shutdown()
      if (this.entries.get(target) === entry) this.entries.delete(target)
    }
  }

  async disposeAll() {
    this.disposed = true
    clearInterval(this.timer)
    const entries = [...this.entries.values()]
    const starting = [...this.starting.values()]
    this.entries.clear()
    await Promise.allSettled([
      ...entries.map((entry) => entry.shutdown()),
      ...starting,
    ])
  }
}
