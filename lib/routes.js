// HTTP API for dsh-bsb-ipynb. One prefix route mounted by better-sidebar's
// webServer service: /ipynb/*.
//
// Every request first passes the same browser-trust fence better-sidebar uses
// for its own routes. Notebook paths are then resolved against the session's
// real workspace and must stay inside it.

import { createRequire } from 'node:module'
import path from 'node:path'
import {
  ApiError,
  readJsonBody,
  requireJsonContentType,
  sendError,
  sendJson,
  sendOk,
} from './json.js'
import {
  assertNotebookPath,
  KernelPaths,
  resolveCreateDirectory,
  resolveExistingFile,
  resolveWorkspace,
  resolveTarget,
} from './gate.js'
import { NOTEBOOK_CAP_BYTES, createNotebookFile, readNotebookFile, saveNotebookFile } from './notebook.js'
import { cachedInterpreters, discoverInterpreters, resolveInterpreter } from './env.js'

const PACKAGE_VERSION = createRequire(import.meta.url)('../package.json').version

const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
}

// A client that stops reading must not keep the NDJSON response open forever.
const EXECUTE_DRAIN_TIMEOUT_MS = 10_000
// The save body only carries a notebook that the server caps at 32 MiB anyway;
// keep a small allowance for the wrapper fields and rejected-oversize payloads.
const SAVE_BODY_CAP_BYTES = NOTEBOOK_CAP_BYTES + 4 * 1024 * 1024
// Continuous admission-fence failures must not flood the server log.
const FENCE_LOG_INTERVAL_MS = 10_000
let lastFenceLogAt = 0

const ROUTES = [
  { method: 'GET', path: '/ipynb/health', handle: healthRoute },
  { method: 'GET', path: '/ipynb/interpreters', handle: interpretersRoute },
  { method: 'GET', path: '/ipynb/config', handle: configRoute },
  { method: 'POST', path: '/ipynb/config', handle: configRoute },
  { method: 'GET', path: '/ipynb/status', handle: statusRoute },
  { method: 'POST', path: '/ipynb/create', handle: createRoute },
  { method: 'POST', path: '/ipynb/read', handle: readRoute },
  { method: 'POST', path: '/ipynb/save', handle: saveRoute },
  { method: 'POST', path: '/ipynb/execute', handle: executeRoute },
  { method: 'POST', path: '/ipynb/interrupt', handle: interruptRoute },
  { method: 'POST', path: '/ipynb/restart', handle: restartRoute },
  { method: 'POST', path: '/ipynb/shutdown', handle: shutdownRoute },
]

export function registerIpynbRoutes(ctx, kernels, options = {}) {
  const kernelPaths = new KernelPaths(ctx, kernels)
  // The drain timeout is injectable so tests can use a short real-socket wait
  // instead of sleeping for the production default; the public default is
  // unchanged (10 s).
  const drainTimeoutMs = Number.isFinite(options.drainTimeoutMs) && options.drainTimeoutMs > 0
    ? options.drainTimeoutMs
    : EXECUTE_DRAIN_TIMEOUT_MS
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/ipynb',
    handler: (req, res) => handleRequest(ctx, kernels, kernelPaths, req, res, drainTimeoutMs),
  })
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, {
    'content-type': 'application/json; charset=utf-8',
    allow,
    'cache-control': 'no-store',
  })
  res.end(
    JSON.stringify({
      ok: false,
      error: { code: 'method-not-allowed', message: `Method not allowed; use ${allow}` },
    }),
  )
}

function fence(ctx, req) {
  let rejected
  try {
    rejected = ctx.connection.requestRejection(req)
  } catch (error) {
    const now = Date.now()
    if (now - lastFenceLogAt > FENCE_LOG_INTERVAL_MS) {
      lastFenceLogAt = now
      console.error('[dsh-bsb-ipynb] request admission check failed:', error)
    }
    rejected = 403
  }
  if (rejected !== undefined && rejected !== null) {
    return rejected || 403
  }
  return undefined
}

// Track execute requests before any asynchronous body/path/interpreter work.
// Request streams may close normally after their body is consumed, so only an
// explicit request abort or a terminated response counts as a disconnection.
function watchExecutionDisconnect(req, res) {
  let disconnected = false
  const close = () => { disconnected = true }
  if (typeof res.on === 'function') {
    res.on('close', close)
    res.on('error', close)
  }
  return {
    isDisconnected: () => disconnected || req.aborted === true ||
      res.destroyed === true || res.closed === true || res.writableEnded === true,
    dispose() {
      if (typeof res.removeListener === 'function') {
        res.removeListener('close', close)
        res.removeListener('error', close)
      } else if (typeof res.off === 'function') {
        res.off('close', close)
        res.off('error', close)
      }
    },
  }
}

async function handleRequest(ctx, kernels, kernelPaths, req, res, drainTimeoutMs) {
  let executionConnection
  try {
    const rejection = fence(ctx, req)
    if (rejection !== undefined) {
      sendJson(res, rejection, {
        ok: false,
        error: { code: 'forbidden', message: 'Request rejected by the host' },
      })
      return
    }
    const url = new URL(req.url || '/', 'http://localhost')
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname
    const method = String(req.method || 'GET').toUpperCase()
    const route = ROUTES.find((candidate) => candidate.path === pathname && candidate.method === method)
    if (!route) {
      const allowed = ROUTES.filter((candidate) => candidate.path === pathname).map((candidate) => candidate.method)
      if (allowed.length) {
        methodNotAllowed(res, allowed.join(', '))
        return
      }
      throw new ApiError('not-found', 404, `Unknown endpoint: ${pathname}`)
    }
    if (route.handle === executeRoute) {
      executionConnection = watchExecutionDisconnect(req, res)
      if (executionConnection.isDisconnected()) return
    }
    if (method === 'POST') {
      requireJsonContentType(req)
    }
    const body = method === 'POST'
      ? await readJsonBody(req, pathname === '/ipynb/save' ? SAVE_BODY_CAP_BYTES : undefined)
      : {}
    if (executionConnection?.isDisconnected()) return
    const value = await route.handle({
      ctx, kernels, kernelPaths, req, res, url, body, drainTimeoutMs,
      isDisconnected: executionConnection?.isDisconnected,
    })
    if (!res.headersSent && !executionConnection?.isDisconnected()) {
      if (value === undefined) sendOk(res, {})
      else sendOk(res, value)
    }
  } catch (error) {
    if (!executionConnection?.isDisconnected()) sendError(res, error)
  } finally {
    // Streaming has its own close/error handlers, retained while queued output
    // drains after executeRoute returns. Remove only these early listeners.
    executionConnection?.dispose()
  }
}

async function healthRoute({ kernels }) {
  const cached = cachedInterpreters()
  if (!cached) {
    // Keep /health cheap: warm the interpreter cache in the background instead
    // of blocking a probe on per-interpreter startup checks.
    void discoverInterpreters().catch(() => {})
  }
  return {
    version: PACKAGE_VERSION,
    kernels: kernels.kernelCount,
    interpreters: {
      checked: Boolean(cached),
      total: cached ? cached.interpreters.length : 0,
      ok: cached ? cached.interpreters.filter((entry) => entry.ok).length : 0,
    },
  }
}

async function interpretersRoute() {
  const discovered = await discoverInterpreters()
  return {
    interpreters: discovered.interpreters,
    default: discovered.default,
  }
}

async function configRoute({ kernels, req, body }) {
  if (String(req.method || 'GET').toUpperCase() === 'POST') {
    kernels.setIdleMinutes(body.idleMinutes)
  }
  return kernels.config()
}

async function createRoute({ ctx, body }) {
  const { directory } = await resolveCreateDirectory(ctx, body.sessionId, body.path)
  const target = await createNotebookFile(directory)
  return { path: target, name: path.basename(target) }
}

async function resolveNotebook({ ctx }, sessionId, requestedPath) {
  const { target } = await resolveExistingFile(ctx, sessionId, requestedPath)
  assertNotebookPath(target)
  return target
}

async function statusRoute({ kernels, kernelPaths, url }) {
  const sessionId = url.searchParams.get('sessionId')
  const requestedPath = url.searchParams.get('path')
  // Control paths do not require the file to still exist (see kernelFor).
  const { target } = await kernelPaths.resolve(sessionId, requestedPath, true)
  return kernels.status(target)
}

async function readRoute({ ctx, body }) {
  const target = await resolveNotebook({ ctx }, body.sessionId, body.path)
  return readNotebookFile(target)
}

async function saveRoute({ ctx, body }) {
  let target
  try {
    target = await resolveNotebook({ ctx }, body.sessionId, body.path)
  } catch (error) {
    // Only a genuinely missing file may be reported as a 409 conflict. Gate
    // errors that carry a reason (EACCES/ENOTDIR/...) must stay 404-class.
    if (error instanceof ApiError && error.code === 'not-found' && error.details === undefined) {
      throw new ApiError('write-conflict', 409, 'Notebook file no longer exists', { version: null })
    }
    throw error
  }
  if (body.notebook === undefined) {
    throw new ApiError('bad-request', 400, 'notebook is required')
  }
  return saveNotebookFile(target, body.notebook, body.baseVersion)
}

async function executeRoute({ kernels, kernelPaths, req, res, body, isDisconnected, drainTimeoutMs }) {
  if (isDisconnected()) return
  const resolved = await kernelPaths.resolve(body.sessionId, body.path)
  const { target } = resolved
  if (isDisconnected()) return
  if (typeof body.code !== 'string') {
    throw new ApiError('bad-request', 400, 'code must be a string')
  }
  const cellId = typeof body.cellId === 'string' && body.cellId ? body.cellId : 'cell'
  const interpreter = await resolveInterpreter(body.python)
  if (isDisconnected()) return

  let closed = false
  let draining = false
  let queuedBytes = 0
  let finished = false
  let cancelled = false
  let runActive = false
  const execution = new AbortController()
  const queue = []
  const stopExecution = () => {
    if (cancelled) return
    closed = true
    queue.length = 0
    queuedBytes = 0
    if (finished) return
    // Stop both disconnected requests and output-limit failures. Set the
    // guard first: abort listeners and interrupt errors can reenter handlers.
    cancelled = true
    execution.abort()
    if (runActive) void kernels.interrupt(target).catch(() => {})
  }
  const flush = () => {
    if (isDisconnected()) {
      stopExecution()
      return
    }
    while (!closed && !draining && queue.length) {
      const line = queue[0]
      let accepted = true
      try {
        accepted = res.write(line) !== false
      } catch {
        stopExecution()
        return
      }
      // A synchronous close/error from write() already cleared the queue.
      if (closed) return
      queue.shift()
      queuedBytes -= Buffer.byteLength(line)
      if (!accepted) {
        draining = true
        if (typeof res.once === 'function') {
          res.once('drain', () => {
            draining = false
            flush()
          })
        } else {
          draining = false
        }
        return
      }
    }
  }
  const write = (event) => {
    if (isDisconnected()) stopExecution()
    if (closed) return
    const line = `${JSON.stringify(event)}\n`
    queuedBytes += Buffer.byteLength(line)
    if (queuedBytes > 64 * 1024 * 1024) {
      // Cancel before ending the response: a slow client may postpone close
      // indefinitely, and the kernel may produce no further output.
      stopExecution()
      try {
        res.end(`${JSON.stringify({ type: 'fatal', code: 'output-too-large', message: 'Execution output exceeded 64 MiB' })}\n`)
      } catch {
        // Already closed.
      }
      return
    }
    queue.push(line)
    flush()
  }
  // A client that stops reading must not keep the response (and its socket)
  // open forever: force the NDJSON end after a bounded drain wait.
  let endTimer = null
  const forceEnd = () => {
    endTimer = null
    if (closed) return
    queue.length = 0
    queuedBytes = 0
    draining = false
    closed = true
    if (typeof res.destroy === 'function') {
      try {
        res.destroy()
      } catch {
        // Already closed.
      }
    } else if (typeof res.end === 'function') {
      // Compatibility with response test doubles that do not implement destroy.
      try {
        res.end()
      } catch {
        // Already closed.
      }
    }
  }
  // Flush everything the kernel produced before ending. `res.end()` while
  // writes are still queued behind backpressure would drop the final
  // execute_reply and make a truncated run look successful.
  const end = () => {
    if (isDisconnected()) stopExecution()
    if (closed) return
    if (!draining && queue.length) flush()
    if (closed) return
    if (draining || queue.length) {
      if (typeof res.once === 'function') {
        res.once('drain', end)
        if (endTimer === null) {
          endTimer = setTimeout(forceEnd, drainTimeoutMs || EXECUTE_DRAIN_TIMEOUT_MS)
          if (endTimer.unref) endTimer.unref()
        }
        return
      }
      queue.length = 0
      queuedBytes = 0
    }
    if (endTimer !== null) {
      clearTimeout(endTimer)
      endTimer = null
    }
    closed = true
    if (typeof res.end === 'function') {
      try {
        res.end()
      } catch {
        // Already closed.
      }
    }
  }
  if (typeof res.on === 'function') res.on('close', stopExecution)
  res.on && res.on('error', stopExecution)
  let ping
  try {
    if (isDisconnected()) {
      stopExecution()
      return
    }
    res.writeHead(200, NDJSON_HEADERS)
    ping = setInterval(() => write({ type: 'ping' }), 15_000)
    if (ping.unref) ping.unref()
    write({ type: 'status', phase: 'starting' })
    if (closed || isDisconnected()) {
      stopExecution()
      return
    }
    const entry = await kernels.getOrStart(target, interpreter.path, {
      prepareReplacement: () => kernelPaths.prepareReplacement(resolved),
    })
    // The response can close while the kernel was starting; running the cell
    // then would execute code no client is listening for.
    if (closed || isDisconnected()) {
      stopExecution()
      return
    }
    runActive = true
    try {
      await entry.run(cellId, body.code, write, { signal: execution.signal })
    } finally {
      runActive = false
    }
  } catch (error) {
    if (!res.headersSent) throw error
    const api = error instanceof ApiError ? error : new ApiError('internal', 500, error.message)
    write({ type: 'fatal', code: api.code, message: api.message })
  } finally {
    finished = true
    clearInterval(ping)
    if (res.headersSent) end()
  }
  return undefined
}

async function kernelFor(kernelPaths, kernels, body) {
  // Deleting or renaming a notebook must not orphan its kernel: control
  // endpoints resolve the path without requiring the file to exist.
  const { target } = await kernelPaths.resolve(body.sessionId, body.path, true)
  const entry = kernels.peek(target)
  if (!entry) {
    throw new ApiError('kernel-unavailable', 503, 'No kernel is running for this notebook')
  }
  return { target, entry }
}

async function interruptRoute({ kernelPaths, kernels, body }) {
  const { entry } = await kernelFor(kernelPaths, kernels, body)
  await entry.interrupt()
  return {}
}

async function restartRoute({ kernelPaths, kernels, body }) {
  const resolved = await kernelPaths.resolve(body.sessionId, body.path, true)
  const { target } = resolved
  const entry = kernels.peek(target)
  // allowMissing keeps deleted notebooks controllable while their kernel is
  // alive. A path that never existed has neither a file nor a kernel and must
  // not become a way to spawn arbitrary Python processes.
  if (!entry && !resolved.stat) {
    throw new ApiError('not-found', 404, `File not found: ${body.path}`)
  }
  const interpreter = await resolveInterpreter(body.python)
  const restarted = await kernels.restart(target, interpreter.path, {
    allowStart: Boolean(resolved.stat),
    prepareReplacement: () => kernelPaths.prepareReplacement(resolved),
  })
  return { python: restarted.python }
}

async function shutdownRoute({ kernelPaths, kernels, body }) {
  const { target } = await kernelPaths.resolve(body.sessionId, body.path, true)
  await kernels.shutdown(target)
  return {}
}

// Re-exported for tests that want to exercise the path gate without HTTP.
export { resolveWorkspace, resolveTarget }
