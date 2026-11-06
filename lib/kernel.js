// Kernel process management for dsh-bsb-ipynb.
//
// One python/bridge.py process per notebook path. The bridge speaks JSON
// lines over stdio and owns the real Jupyter kernel, so this file only does
// process lifetime, FIFO bookkeeping and event fan-out.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { ApiError } from './json.js'

const READY_TIMEOUT_MS = 30_000
const SHUTDOWN_GRACE_MS = 2_000
const STDERR_TAIL_BYTES = 8 * 1024
const MAX_LINE_BYTES = 64 * 1024 * 1024
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000

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
    this.readyResolve = null
    this.readyReject = null
    this.readyTimer = null
    this.stderrTail = ''
    this.stdoutBuffer = ''
    this.stopping = false
  }

  ensureStarted() {
    if (this.stopping) {
      return Promise.reject(new ApiError('kernel-unavailable', 503, 'Kernel is shutting down'))
    }
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
    const python = this.python
    const bridge = this.manager.bridgePath
    const dir = path.dirname(this.target)
    let proc
    try {
      proc = spawn(python, ['-u', bridge, '--cwd', dir], {
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
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    if (proc.stdin) {
      // A write can fail asynchronously (EPIPE when the bridge dies between our
      // write and its read). Without this listener Node turns that into an
      // uncaughtException and can take the whole DSH host down.
      proc.stdin.on('error', (error) => this.handleStdinError(error))
    }
    proc.stdout.on('data', (chunk) => this.handleStdout(chunk))
    proc.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
    })
    proc.on('error', (error) => {
      this.failReady(`Failed to start Python: ${error.message}`)
    })
    proc.on('exit', (code, signal) => this.handleExit(code, signal))

    return new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      this.readyTimer = setTimeout(() => {
        const tail = this.stderrTail.trim()
        const suffix = tail ? ` Python reported: ${tail}` : ' No output was produced.'
        this.kill()
        this.failReady(`Python kernel did not become ready within 30 seconds.${suffix}`)
      }, READY_TIMEOUT_MS)
      if (this.readyTimer.unref) this.readyTimer.unref()
    })
  }

  failReady(message) {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    if (this.proc) this.kill()
    this.ready = false
    this.executionState = 'dead'
    this.lastError = message
    const reject = this.readyReject
    this.readyReject = null
    this.readyResolve = null
    if (reject) reject(new ApiError('kernel-unavailable', 503, message))
    this.failRun(message)
  }

  finishReady() {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    this.ready = true
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

  emit(event) {
    this.lastActivity = Date.now()
    if (event.type === 'status') {
      this.executionState = event.execution_state || this.executionState
    }
    if (event.type === 'execute_reply') {
      this.executionState = 'idle'
      const run = this.currentRun
      if (run && event.cell_id === run.cellId) {
        this.dispatch(event)
        this.settleRun(run, event)
      }
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
    this.dispatch(event)
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk
    if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
      this.stdoutBuffer = ''
      this.lastError = 'Kernel produced an oversized output line'
      return
    }
    let index = this.stdoutBuffer.indexOf('\n')
    while (index !== -1) {
      const line = this.stdoutBuffer.slice(0, index).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (line) this.handleLine(line)
      index = this.stdoutBuffer.indexOf('\n')
    }
  }

  handleLine(line) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      this.lastError = `Unreadable kernel event: ${line.slice(0, 200)}`
      return
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return
    if (event.type === 'ready') {
      this.finishReady()
    }
    if (event.type === 'status_reply') {
      this.dispatch(event)
      return
    }
    this.emit(event)
  }

  handleExit(code, signal) {
    const wasStopping = this.stopping
    this.proc = null
    this.ready = false
    this.executionState = 'dead'
    const reason =
      wasStopping
        ? 'Kernel stopped'
        : this.lastError || `Kernel process exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'none'})`
    this.lastError = reason
    // Settle any accepted execution on every exit path, including shutdown,
    // so an HTTP NDJSON stream can never wait forever.
    if (!wasStopping) this.emit({ type: 'kernel_died', message: reason })
    else this.failRun(reason)
    if (!wasStopping) this.failReady(reason)
    this.manager.forget(this.target)
  }

  handleStdinError(error) {
    const message = `Failed to talk to the kernel: ${error.message}`
    this.lastError = message
    this.ready = false
    this.executionState = 'dead'
    this.failRun(message)
    if (!this.stopping && this.readyReject) this.failReady(message)
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

  async run(cellId, code, onEvent) {
    if (this.busy || this.currentRun) {
      throw new ApiError('kernel-busy', 409, 'The kernel is already executing a cell')
    }
    if (!this.proc || !this.ready) {
      throw new ApiError('kernel-unavailable', 503, 'Kernel is not ready')
    }
    const run = { cellId, listener: typeof onEvent === 'function' ? onEvent : null, resolve: null, settled: false }
    const result = new Promise((resolve) => {
      run.resolve = resolve
    })
    this.currentRun = run
    this.busy = true
    this.executionState = 'busy'
    this.lastActivity = Date.now()
    try {
      this.write({ op: 'execute', cell_id: cellId, code })
    } catch (error) {
      // A failed write must not leave a phantom busy kernel behind: the caller
      // gets the error and the next request is allowed to try again.
      this.currentRun = null
      this.busy = false
      throw error
    }
    return result
  }

  async interrupt() {
    if (!this.proc) throw new ApiError('kernel-unavailable', 503, 'Kernel is not running')
    this.write({ op: 'interrupt' })
  }

  async restart() {
    if (!this.proc) {
      throw new ApiError('kernel-unavailable', 503, 'Kernel is not running')
    }
    // The bridge does not answer the interrupted cell's shell request on every
    // jupyter_client/kernel combination, so settle it here instead of leaving
    // the HTTP stream (and the client's run-all loop) pending forever.
    this.failRun('Kernel restarted before the cell finished')
    this.executionState = 'starting'
    this.write({ op: 'restart' })
  }

  async shutdown() {
    this.stopping = true
    this.failRun('Kernel shut down before the cell finished')
    this.ready = false
    const proc = this.proc
    if (!proc) {
      this.manager.forget(this.target)
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
      this.kill()
    }, SHUTDOWN_GRACE_MS)
    if (timer.unref) timer.unref()
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS + 500))])
    clearTimeout(timer)
    this.manager.forget(this.target)
  }

  kill() {
    const proc = this.proc
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
    this.timer = setInterval(() => this.sweepIdle(), 60_000)
    if (this.timer.unref) this.timer.unref()
  }

  async getOrStart(target, python) {
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
    let entry = this.entries.get(target)
    if (entry && entry.python !== python) {
      if (entry.busy) {
        throw new ApiError('kernel-busy', 409, 'Restart the kernel before switching interpreters')
      }
      await entry.shutdown()
      this.entries.delete(target)
      entry = undefined
    }
    if (!entry) {
      entry = new KernelEntry(this, target, python)
      this.entries.set(target, entry)
    }
    await entry.ensureStarted()
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

  forget(target) {
    const entry = this.entries.get(target)
    if (entry && !entry.proc) this.entries.delete(target)
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
    this.entries.delete(target)
    return true
  }

  async sweepIdle() {
    const ttl = idleTtlMs()
    const now = Date.now()
    for (const [target, entry] of this.entries) {
      if (entry.busy || entry.startPromise) continue
      if (now - entry.lastActivity < ttl) continue
      await entry.shutdown()
      this.entries.delete(target)
    }
  }

  async disposeAll() {
    clearInterval(this.timer)
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(entries.map((entry) => entry.shutdown()))
  }
}
