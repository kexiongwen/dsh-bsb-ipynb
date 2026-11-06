// HTTP API for dsh-bsb-ipynb. One prefix route mounted by better-sidebar's
// webServer service: /ipynb/*.
//
// Every request first passes the same browser-trust fence better-sidebar uses
// for its own routes. Notebook paths are then resolved against the session's
// real workspace and must stay inside it.

import {
  ApiError,
  readJsonBody,
  requireJsonContentType,
  sendError,
  sendJson,
  sendOk,
} from './json.js'
import { assertNotebookPath, resolveExistingFile, resolveWorkspace, resolveTarget } from './gate.js'
import { readNotebookFile, saveNotebookFile } from './notebook.js'
import { discoverInterpreters, resolveInterpreter } from './env.js'

const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
}

const ROUTES = [
  { method: 'GET', path: '/ipynb/health', handle: healthRoute },
  { method: 'GET', path: '/ipynb/interpreters', handle: interpretersRoute },
  { method: 'GET', path: '/ipynb/status', handle: statusRoute },
  { method: 'POST', path: '/ipynb/read', handle: readRoute },
  { method: 'POST', path: '/ipynb/save', handle: saveRoute },
  { method: 'POST', path: '/ipynb/execute', handle: executeRoute },
  { method: 'POST', path: '/ipynb/interrupt', handle: interruptRoute },
  { method: 'POST', path: '/ipynb/restart', handle: restartRoute },
  { method: 'POST', path: '/ipynb/shutdown', handle: shutdownRoute },
]

export function registerIpynbRoutes(ctx, kernels) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/ipynb',
    handler: (req, res) => handleRequest(ctx, kernels, req, res),
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
    console.error('[dsh-bsb-ipynb] request admission check failed:', error)
    rejected = 403
  }
  if (rejected !== undefined && rejected !== null) {
    return rejected || 403
  }
  return undefined
}

async function handleRequest(ctx, kernels, req, res) {
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
    const route = ROUTES.find((candidate) => candidate.path === pathname)
    if (!route) {
      throw new ApiError('not-found', 404, `Unknown endpoint: ${pathname}`)
    }
    const method = String(req.method || 'GET').toUpperCase()
    if (method !== route.method) {
      methodNotAllowed(res, route.method)
      return
    }
    if (method === 'POST') {
      requireJsonContentType(req)
    }
    const body = method === 'POST' ? await readJsonBody(req) : {}
    const value = await route.handle({ ctx, kernels, req, res, url, body })
    if (!res.headersSent) {
      if (value === undefined) sendOk(res, {})
      else sendOk(res, value)
    }
  } catch (error) {
    sendError(res, error)
  }
}

async function healthRoute({ kernels }) {
  const discovered = await discoverInterpreters()
  return {
    version: '0.1.0',
    kernels: kernels.kernelCount,
    interpreters: {
      total: discovered.interpreters.length,
      ok: discovered.interpreters.filter((entry) => entry.ok).length,
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

async function resolveNotebook({ ctx }, sessionId, requestedPath) {
  const { target } = await resolveExistingFile(ctx, sessionId, requestedPath)
  assertNotebookPath(target)
  return target
}

async function statusRoute({ ctx, kernels, url }) {
  const sessionId = url.searchParams.get('sessionId')
  const requestedPath = url.searchParams.get('path')
  const target = await resolveNotebook({ ctx }, sessionId, requestedPath)
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
    if (error instanceof ApiError && error.code === 'not-found') {
      throw new ApiError('write-conflict', 409, 'Notebook file no longer exists', { version: null })
    }
    throw error
  }
  if (body.notebook === undefined) {
    throw new ApiError('bad-request', 400, 'notebook is required')
  }
  return saveNotebookFile(target, body.notebook, body.baseVersion)
}

async function executeRoute({ ctx, kernels, req, res, body }) {
  const target = await resolveNotebook({ ctx }, body.sessionId, body.path)
  if (typeof body.code !== 'string') {
    throw new ApiError('bad-request', 400, 'code must be a string')
  }
  const cellId = typeof body.cellId === 'string' && body.cellId ? body.cellId : 'cell'
  const interpreter = await resolveInterpreter(body.python)

  res.writeHead(200, NDJSON_HEADERS)
  let closed = false
  let draining = false
  let queuedBytes = 0
  const queue = []
  const flush = () => {
    while (!closed && !draining && queue.length) {
      const line = queue[0]
      let accepted = true
      try {
        accepted = res.write(line) !== false
      } catch {
        closed = true
        return
      }
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
    if (closed) return
    const line = `${JSON.stringify(event)}\n`
    queuedBytes += Buffer.byteLength(line)
    if (queuedBytes > 64 * 1024 * 1024) {
      // Never let one fast kernel exhaust the host's memory. Send one final
      // fatal event so the client marks the cell as failed, then end.
      closed = true
      queue.length = 0
      queuedBytes = 0
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
  const close = () => {
    closed = true
    queue.length = 0
    queuedBytes = 0
  }
  // Flush everything the kernel produced before ending. `res.end()` while
  // writes are still queued behind backpressure would drop the final
  // execute_reply and make a truncated run look successful.
  const end = () => {
    if (closed) return
    if (!draining && queue.length) flush()
    if (closed) return
    if (draining || queue.length) {
      if (typeof res.once === 'function') {
        res.once('drain', end)
        return
      }
      queue.length = 0
      queuedBytes = 0
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
  if (typeof res.on === 'function') res.on('close', close)
  res.on && res.on('error', close)
  const ping = setInterval(() => write({ type: 'ping' }), 15_000)
  if (ping.unref) ping.unref()
  write({ type: 'status', phase: 'starting' })
  try {
    const entry = await kernels.getOrStart(target, interpreter.path)
    await entry.run(cellId, body.code, write)
  } catch (error) {
    const api = error instanceof ApiError ? error : new ApiError('internal', 500, error.message)
    write({ type: 'fatal', code: api.code, message: api.message })
  } finally {
    clearInterval(ping)
    end()
  }
  return undefined
}

async function kernelFor(ctx, kernels, body) {
  const target = await resolveNotebook({ ctx }, body.sessionId, body.path)
  const entry = kernels.peek(target)
  if (!entry) {
    throw new ApiError('kernel-unavailable', 503, 'No kernel is running for this notebook')
  }
  return { target, entry }
}

async function interruptRoute({ ctx, kernels, body }) {
  const { entry } = await kernelFor(ctx, kernels, body)
  await entry.interrupt()
  return {}
}

async function restartRoute({ ctx, kernels, body }) {
  const target = await resolveNotebook({ ctx }, body.sessionId, body.path)
  const interpreter = await resolveInterpreter(body.python)
  const entry = kernels.peek(target)
  if (entry && entry.python !== interpreter.path) {
    if (entry.busy) {
      throw new ApiError('kernel-busy', 409, 'Wait for the running cell to finish before switching interpreters')
    }
    await kernels.shutdown(target)
  }
  if (kernels.peek(target)) {
    await kernels.restart(target)
  } else {
    await kernels.getOrStart(target, interpreter.path)
  }
  return { python: interpreter.path }
}

async function shutdownRoute({ ctx, kernels, body }) {
  const target = await resolveNotebook({ ctx }, body.sessionId, body.path)
  await kernels.shutdown(target)
  return {}
}

// Re-exported for tests that want to exercise the path gate without HTTP.
export { resolveWorkspace, resolveTarget }
