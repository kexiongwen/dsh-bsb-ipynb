// Shared HTTP helpers for the dsh-bsb-ipynb host half.
// Route handlers receive better-sidebar's SidebarWebRequest / SidebarHttpResponse
// shape (an async-iterable request body and a Node-like response).

const STATUS_BY_CODE = {
  'bad-request': 400,
  forbidden: 403,
  'workspace-unknown': 400,
  'path-outside-root': 403,
  'not-found': 404,
  'not-notebook': 400,
  'too-large': 413,
  'write-conflict': 409,
  'write-failed': 500,
  'kernel-busy': 409,
  'kernel-unavailable': 503,
  'interpreter-unknown': 400,
  'method-not-allowed': 405,
  internal: 500,
}

export class ApiError extends Error {
  constructor(code, status, message, details) {
    super(message || code)
    this.name = 'ApiError'
    this.code = code
    this.status = status ?? STATUS_BY_CODE[code] ?? 500
    this.details = details
  }
}

export function errorPayload(error) {
  const api = error instanceof ApiError ? error : new ApiError('internal', 500, 'Internal error')
  const payload = { code: api.code, message: api.message }
  if (api.details !== undefined) payload.details = api.details
  return { status: api.status, payload }
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

export function sendOk(res, value) {
  sendJson(res, 200, { ok: true, value })
}

export function sendError(res, error) {
  if (!(error instanceof ApiError)) {
    console.error('[dsh-bsb-ipynb] unexpected error:', error)
  }
  const { status, payload } = errorPayload(error)
  try {
    sendJson(res, status, { ok: false, error: payload })
  } catch {
    try {
      res.end()
    } catch {
      // The socket is already gone; nothing else to do.
    }
  }
}

export function headerValue(req, name) {
  const headers = req && req.headers
  if (!headers) return undefined
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined
  const lowered = String(name).toLowerCase()
  if (Object.prototype.hasOwnProperty.call(headers, lowered)) return headers[lowered]
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowered) return headers[key]
  }
  return undefined
}

export function requireJsonContentType(req) {
  const contentType = String(headerValue(req, 'content-type') || '')
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    throw new ApiError('bad-request', 400, 'Content-Type must be application/json')
  }
}

export async function readJsonBody(req, limit) {
  const cap = typeof limit === 'number' ? limit : 64 * 1024 * 1024
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > cap) {
      throw new ApiError('too-large', 413, `Request body exceeds ${Math.floor(cap / 1024 / 1024)} MiB`)
    }
    chunks.push(buffer)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw new ApiError('bad-request', 400, `Invalid JSON body: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError('bad-request', 400, 'JSON body must be an object')
  }
  return parsed
}
