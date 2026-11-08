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
const KILL_GRACE_MS = 2_000
const EXIT_CONFIRM_MS = 500
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

// Every event the bridge emits for one execution echoes the host's cell_id and
// exec_id (see python/bridge.py). status/execute_reply are not routed through
// the generic EXECUTION_EVENTS branch but carry the same execution scoping.
const SCOPED_EVENTS = new Set([...EXECUTION_EVENTS, 'status', 'execute_reply'])

export function exceedsMaxLineBytes(bytes) {
  return bytes > MAX_LINE_BYTES
}

// Validate the execution scoping the bridge protocol promises. A frame that
// lost its IDs cannot be attributed to a run, so it is a protocol error rather
// than an event to discard.
function scopedEventError(event) {
  if (SCOPED_EVENTS.has(event.type)) {
    if (typeof event.cell_id !== 'string' || typeof event.exec_id !== 'string') {
      return `Invalid kernel event: ${event.type} must carry string cell_id and exec_id`
    }
    return null
  }
  if (event.type === 'kernel_died') {
    // A whole-kernel death is untagged by design; an execution-scoped death
    // must carry both IDs.
    const scoped = event.cell_id !== undefined || event.exec_id !== undefined
    if (scoped && (typeof event.cell_id !== 'string' || typeof event.exec_id !== 'string')) {
      return 'Invalid kernel event: a scoped kernel_died must carry string cell_id and exec_id'
    }
  }
  return null
}

function idleTtlMs() {
  const configured = Number(process.env.DSH_IPYNB_KERNEL_IDLE_MS)
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_IDLE_TTL_MS
  // 0 disables the idle sweep entirely.
  return configured === 0 ? Infinity : configured
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
    this.shutdownPromise = null
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
    // Bridge protocol failure preserved across the exit event that recycles the
    // desynchronised process (see protocolFault()).
    this.protocolFailure = null
    this.stderrTail = ''
    this.stdoutBuffer = ''
    this.stdoutBytes = 0
    this.stdoutScanIndex = 0
    this.stopping = false
    // Host-chosen path so the file can be removed even after a hard kill.
    this.connectionFile = null
    this.connectionFiles = new WeakMap()
    this.killTimers = new WeakMap()
    this.exitedProcesses = new WeakSet()
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
    this.protocolFailure = null
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
    this.connectionFiles.set(proc, connectionFile)
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
      if (proc.pid === undefined) this.cleanupConnectionFile(proc)
      if (!isCurrentProcess()) return
      const message = `Failed to start Python: ${error.message}`
      // Node never emits 'exit' for a process that could not be spawned
      // (ENOENT/EACCES/EMFILE...). Clear the dead handle here so the entry is
      // forgotten instead of reporting running:true forever.
      if (proc.pid === undefined) {
        this.proc = null
        this.failReady(message)
        this.manager.forget(this.target, this)
        return
      }
      this.failReady(message)
    })
    proc.on('exit', (code, signal) => {
      this.exitedProcesses.add(proc)
      this.clearKillTimer(proc)
      this.cleanupConnectionFile(proc)
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
    this.executionState = this.stopping ? 'stopping' : 'dead'
    this.lastError = message
    this.readyFailure = message
    this.failRun(message)
  }

  finishReady(event) {
    // A bridge judged to be desynchronised is being recycled; its late ready
    // must not re-arm execution on a stream the host no longer trusts.
    if (this.protocolFailure || this.stopping) return
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

  // A stdout frame that breaks the bridge's JSON-lines contract means the
  // stream can no longer be trusted: if the corrupted frame was the only
  // execute_reply, currentRun would stay pending forever (and every later
  // execute behind kernel-busy). Record the cause, settle the active run with
  // a scoped fatal event, and recycle the process instead of reading a
  // desynchronised stream.
  protocolFault(message) {
    // A restart already recycles the kernel and a shutdown is tearing the
    // process down anyway. In particular the tail of the oversized line that
    // triggered a restart can arrive here; it must not overwrite the real
    // cause or start a second teardown.
    if (this.stopping || this.restartPromise) return
    // A bridge that is neither ready nor starting has already failed (a
    // kernel_died, a stdin error or a readiness failure killed it); further
    // garbage from its dying stdout must not replace that cause.
    if (!this.ready && !this.startPromise) return
    // A single corrupted chunk can contain several bad frames; react once.
    if (this.protocolFailure) return
    this.protocolFailure = message
    this.lastError = message
    this.ready = false
    this.executionState = 'dead'
    const run = this.currentRun
    if (run) {
      this.dispatch({ type: 'fatal', code: 'protocol-error', message, cell_id: run.cellId, exec_id: run.execId })
    }
    this.failRun(message)
    // A startup wait is waiting for a bridge that has proven it cannot keep the
    // protocol; fail it now instead of waiting for the 30s ready timeout.
    this.rejectReadyWait(message)
    // Kill the process: its exit handler forgets the entry and the next
    // getOrStart() spawns a replacement bridge.
    this.kill()
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
    if (this.stopping && event.type === 'status') return
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

  // The bridge produced a frame the host refuses to buffer. Abort the run and
  // restart the kernel (not the whole bridge) to stop the flood.
  handleOversizedLine() {
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
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk
    // stdout is decoded as utf8; count UTF-8 bytes (not JS UTF-16 code units)
    // so the cap really is MAX_LINE_BYTES on the wire.
    this.stdoutBytes += Buffer.byteLength(chunk)
    // Consume every complete line before checking the cap. The newline that
    // terminates a frame of exactly MAX_LINE_BYTES can share a chunk with the
    // next frame, so checking the accumulated bytes first would discard a
    // legal frame. stdoutScanIndex avoids rescanning the buffered prefix.
    let index = this.stdoutBuffer.indexOf('\n', this.stdoutScanIndex)
    while (index !== -1) {
      const raw = this.stdoutBuffer.slice(0, index)
      const rawBytes = Buffer.byteLength(raw)
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      this.stdoutBytes -= rawBytes + 1
      // A complete line is still illegal when the line itself is over the cap;
      // its newline merely arrived in this chunk.
      if (exceedsMaxLineBytes(rawBytes)) {
        this.handleOversizedLine()
        return
      }
      const line = raw.trim()
      if (line) this.handleLine(line)
      index = this.stdoutBuffer.indexOf('\n')
    }
    this.stdoutScanIndex = this.stdoutBuffer.length
    // Only the unterminated tail remains. Checking it after the complete lines
    // are gone keeps the cap exact and the buffer bounded (at most MAX + one
    // stream chunk).
    if (exceedsMaxLineBytes(this.stdoutBytes)) this.handleOversizedLine()
  }

  handleLine(line) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      this.protocolFault(`Unreadable kernel event: ${line.slice(0, 200)}`)
      return
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      this.protocolFault(`Invalid kernel event: expected a JSON object: ${line.slice(0, 200)}`)
      return
    }
    if (typeof event.type !== 'string') {
      this.protocolFault(`Invalid kernel event: missing string type: ${line.slice(0, 200)}`)
      return
    }
    const scopeError = scopedEventError(event)
    if (scopeError) {
      this.protocolFault(scopeError)
      return
    }
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
    // The stderr tail is the only clue a crashed bridge leaves behind; stale
    // lastError values (e.g. one unreadable event) must not mask the real cause.
    const stderrTail = this.stderrTail.trim().slice(-2000)
    // A readiness failure carries the actionable cause (e.g. the Python
    // traceback of a failed startup); the generic exit line must not hide it.
    const readyFailure = this.readyFailure
    this.readyFailure = null
    // A protocol failure is the reason this process is being recycled; keep it
    // in the reported cause instead of the generic exit line.
    const protocolFailure = this.protocolFailure
    this.protocolFailure = null
    this.proc = null
    this.ready = false
    this.executionState = 'dead'
    const base = `Kernel process exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'none'})`
    const reason = wasStopping
      ? 'Kernel stopped'
      : protocolFailure
        ? `${protocolFailure}. ${base}`
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
    this.executionState = this.stopping ? 'stopping' : 'dead'
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

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise
    let resolveWait
    let rejectWait
    const wait = new Promise((resolve, reject) => {
      resolveWait = resolve
      rejectWait = reject
    })
    // Publish before failing the run: an output listener can reenter shutdown.
    this.shutdownPromise = wait
    wait.then(
      () => { if (this.shutdownPromise === wait) this.shutdownPromise = null },
      () => { if (this.shutdownPromise === wait) this.shutdownPromise = null },
    )
    this.shutdownProcess().then(resolveWait, rejectWait)
    return wait
  }

  async shutdownProcess() {
    this.stopping = true
    this.failRun('Kernel shut down before the cell finished')
    this.rejectReadyWait('Kernel shut down before it became ready')
    this.ready = false
    this.executionState = 'stopping'
    const proc = this.proc
    if (!proc) {
      this.manager.forget(this.target, this)
      return
    }
    await new Promise((resolve, reject) => {
      let done = false
      let terminateTimer = null
      let deadlineTimer = null
      const finish = (error) => {
        if (done) return
        done = true
        clearTimeout(terminateTimer)
        clearTimeout(deadlineTimer)
        this.clearKillTimer(proc)
        proc.removeListener('exit', onExit)
        proc.removeListener('error', onError)
        if (error) reject(error)
        else resolve()
      }
      const onExit = () => finish()
      // A spawn failure has no child and no exit event. The normal process
      // error handler clears its handle before this listener runs.
      const onError = () => { if (proc.pid === undefined) finish() }
      proc.once('exit', onExit)
      proc.on('error', onError)
      if (this.processExited(proc)) {
        finish()
        return
      }
      // Sending SIGKILL is not proof of exit. Keep the entry managed through
      // escalation and a final confirmation window; a stubborn child fails
      // shutdown instead of being silently replaced while still alive.
      const expired = () => {
        if (done) return
        const message = 'Kernel process did not exit after shutdown and forced termination'
        this.lastError = message
        this.executionState = 'stopping'
        // Unavailable does not mean absent: callers must keep the live stopping
        // process visible and offer a retry rather than report it as off.
        finish(new ApiError('kernel-unavailable', 503, message, { state: 'stopping' }))
      }
      terminateTimer = setTimeout(() => {
        if (done) return
        const escalation = this.kill(proc)
        if (!escalation) {
          if (this.processExited(proc)) finish()
          return
        }
        escalation.forced.then(() => {
          if (done) return
          // Anchor confirmation to the actual signal, not an absolute 4.5s
          // deadline that could run before a delayed escalation timer.
          deadlineTimer = setTimeout(expired, EXIT_CONFIRM_MS)
          if (deadlineTimer.unref) deadlineTimer.unref()
        })
      }, SHUTDOWN_GRACE_MS)
      if (terminateTimer.unref) terminateTimer.unref()
      try {
        if (proc.stdin && !proc.stdin.destroyed && !proc.stdin.writableEnded) {
          proc.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`)
          proc.stdin.end()
        }
      } catch {
        // Fall through to signals. The listeners were installed first so even
        // a synchronous process exit during write() cannot escape observation.
      }
    })
    this.manager.forget(this.target, this)
  }

  // The connection file is host-chosen; remove it on every exit path, including
  // a TerminateProcess that prevented the bridge from cleaning up after itself.
  cleanupConnectionFile(proc = this.proc) {
    const file = proc && this.connectionFiles.get(proc)
    if (!file) return
    this.connectionFiles.delete(proc)
    if (this.proc === proc && this.connectionFile === file) this.connectionFile = null
    void fsp.unlink(file).catch(() => {})
  }

  processExited(proc) {
    return this.exitedProcesses.has(proc) || proc.exitCode != null || proc.signalCode != null
  }

  clearKillTimer(proc) {
    const escalation = this.killTimers.get(proc)
    if (!escalation) return
    if (escalation.timer) clearTimeout(escalation.timer)
    this.killTimers.delete(proc)
    escalation.forceIssued()
  }

  // On Windows both SIGTERM and SIGKILL map to TerminateProcess, so this is a
  // hard kill there; graceful cleanup always comes from the shutdown command.
  kill(proc = this.proc) {
    if (!proc || this.processExited(proc)) return null
    const pending = this.killTimers.get(proc)
    if (pending) return pending
    let forceIssued
    const forced = new Promise((resolve) => { forceIssued = resolve })
    const escalation = { timer: null, forced, forceIssued }
    this.killTimers.set(proc, escalation)
    // Install the timer before SIGTERM: exit can be emitted synchronously by
    // a controlled child, and its callback must be able to cancel escalation.
    escalation.timer = setTimeout(() => {
      if (this.killTimers.get(proc) !== escalation) return
      escalation.timer = null
      try {
        if (!this.processExited(proc)) proc.kill('SIGKILL')
      } catch {
        // Ignore.
      }
      forceIssued()
    }, KILL_GRACE_MS)
    if (escalation.timer.unref) escalation.timer.unref()
    try {
      proc.kill('SIGTERM')
    } catch {
      // The timed escalation still runs when graceful termination fails.
    }
    return escalation
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
    this.operations = new Map()
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

  enqueueLifecycle(target, task, { shutdown = false, skipCancelled = false } = {}) {
    const state = this.operations.get(target) || { tail: null, version: 0 }
    const previous = state.tail
    // Closing is an immediate intent: pending startups/switches must not
    // resume and spawn a replacement after the old process has exited.
    if (shutdown) state.version += 1
    const version = state.version
    const check = () => {
      this.throwIfDisposed()
      if (!shutdown && state.version !== version) {
        throw new ApiError('kernel-unavailable', 503, 'Kernel operation cancelled by shutdown')
      }
    }
    let resolveRun, rejectRun
    const run = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject })
    const tail = run.then(() => {}, () => {})
    state.tail = tail
    this.operations.set(target, state)
    tail.then(() => {
      if (state.tail === tail && this.operations.get(target) === state) this.operations.delete(target)
    })
    const start = () => {
      try {
        if (skipCancelled && (this.disposed || state.version !== version)) {
          resolveRun()
          return
        }
        check()
        Promise.resolve(task(check)).then(resolveRun, rejectRun)
      } catch (error) {
        rejectRun(error)
      }
    }
    // Publish the queue before starting. The first operation remains
    // synchronous up to its first await (notably spawn and ready=false).
    // Return run directly so its caller can submit a cell before the next
    // queued interpreter switch checks whether that entry is busy.
    if (previous) previous.then(start)
    else start()
    return run
  }

  getOrStart(target, python, options = {}) {
    return this.enqueueLifecycle(target, async (check) => {
      const preserveAliases = options.prepareReplacement?.()
      const entry = await this.startEntry(target, python, check)
      check()
      preserveAliases?.(entry)
      return entry
    })
  }

  async startEntry(target, python, check) {
    check()
    let entry = this.entries.get(target)
    if (entry && entry.python !== python) {
      if (entry.busy) {
        throw new ApiError('kernel-busy', 409, 'Restart the kernel before switching interpreters')
      }
      await this.stopEntry(target, entry)
      check()
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
      await this.stopEntry(target, entry)
      this.throwIfDisposed()
    }
    check()
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

  restart(target, python, options = {}) {
    return this.enqueueLifecycle(target, async (check) => {
      const entry = this.entries.get(target)
      if (!entry && (!python || !options.allowStart)) {
        throw python
          ? new ApiError('not-found', 404, 'Notebook file and kernel no longer exist')
          : new ApiError('kernel-unavailable', 503, 'No kernel is running for this notebook')
      }
      const preserveAliases = options.prepareReplacement?.()
      let restarted
      if (!entry || (python && entry.python !== python)) {
        restarted = await this.startEntry(target, python, check)
      } else {
        await entry.restart()
        check()
        restarted = entry
      }
      preserveAliases?.(restarted)
      return restarted
    })
  }

  async stopEntry(target, entry) {
    await entry.shutdown()
    // Never release a path on a timeout or on merely sending a kill signal.
    if (entry.proc) throw new ApiError('kernel-unavailable', 503, 'Kernel process has not exited', { state: 'stopping' })
    this.forget(target, entry)
  }

  shutdown(target) {
    const entry = this.entries.get(target)
    let stopped
    const stop = () => stopped || (stopped = this.stopEntry(target, entry))
    const result = this.enqueueLifecycle(target, async () => {
      if (!entry) return false
      await stop()
      return true
    }, { shutdown: true })
    // A startup/restart can be waiting for ready. Cancel it now, rather than
    // waiting behind it until the readiness timeout; the queue still prevents
    // any subsequent replacement from starting before exit is confirmed.
    if (entry && !this.disposed) void stop().catch(() => {})
    return result
  }

  async sweepIdle() {
    const ttl = idleTtlMs()
    const now = Date.now()
    for (const [target, entry] of this.entries) {
      if (entry.busy || entry.startPromise || entry.restartPromise || entry.stopping) continue
      if (now - entry.lastActivity < ttl) continue
      await this.enqueueLifecycle(target, async () => {
        // A queued request may have used or replaced this entry meanwhile.
        if (this.entries.get(target) !== entry || entry.busy || entry.startPromise || entry.restartPromise || entry.stopping) return
        if (Date.now() - entry.lastActivity < idleTtlMs()) return
        await this.stopEntry(target, entry)
      }, { skipCancelled: true })
    }
  }

  async disposeAll() {
    this.disposed = true
    clearInterval(this.timer)
    const entries = [...this.entries]
    const pending = [...this.operations.values()].map((state) => state.tail)
    await Promise.allSettled([
      ...entries.map(([target, entry]) => this.stopEntry(target, entry)),
      ...pending,
    ])
    if (this.entries.size) {
      throw new ApiError('kernel-unavailable', 503, 'Some kernel processes have not exited during disposal')
    }
  }
}
