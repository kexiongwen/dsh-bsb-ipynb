import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { registerIpynbRoutes } from '../lib/routes.js'
import { readJsonBody } from '../lib/json.js'
import { discoverInterpreters } from '../lib/env.js'
import { NOTEBOOK_CAP_BYTES, emptyNotebook, serializeNotebook, sha256 } from '../lib/notebook.js'
import { tempDir } from './python-helper.mjs'
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

function makeRes() {
  const state = { status: 0, headers: {}, chunks: [], ended: false }
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      state.status = status
      Object.assign(state.headers, headers || {})
      res.headersSent = true
      return res
    },
    write(chunk) {
      state.chunks.push(Buffer.from(chunk))
      return true
    },
    end(chunk) {
      if (chunk) state.chunks.push(Buffer.from(chunk))
      state.ended = true
    },
    on() {
      return res
    },
  }
  return { res, state }
}

function trackedRes() {
  const state = { status: 0, headers: {}, chunks: [], ended: false, handlers: new Map() }
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      state.status = status
      Object.assign(state.headers, headers || {})
      res.headersSent = true
      return res
    },
    write(chunk) {
      state.chunks.push(Buffer.from(chunk))
      return true
    },
    end(chunk) {
      if (chunk) state.chunks.push(Buffer.from(chunk))
      state.ended = true
    },
    on(event, callback) {
      const handlers = state.handlers.get(event) || []
      handlers.push(callback)
      state.handlers.set(event, handlers)
      return res
    },
    once(event, callback) {
      return res.on(event, callback)
    },
    emit(event) {
      for (const callback of state.handlers.get(event) || []) callback()
    },
  }
  return { res, state }
}

function makeReq({ method = 'GET', url = '/ipynb/health', body, rejection, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    rejection,
  }
}

function makeCtx({ cwd, rejection } = {}) {
  const registered = []
  return {
    registered,
    sessions: {
      get(id) {
        return id === 's1' && cwd ? { header: { cwd } } : undefined
      },
    },
    connection: {
      requestRejection() {
        return rejection
      },
    },
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
  }
}

function makeKernels() {
  const calls = []
  const entry = {
    python: '/fake/python',
    busy: false,
    async run(cellId, code, onEvent) {
      calls.push({ cellId, code })
      onEvent({ type: 'status', execution_state: 'busy', cell_id: cellId })
      onEvent({ type: 'stream', cell_id: cellId, name: 'stdout', text: 'hello\n' })
      onEvent({ type: 'execute_reply', cell_id: cellId, ok: true, execution_count: 3 })
      return { type: 'execute_reply', cell_id: cellId, ok: true, execution_count: 3 }
    },
    async interrupt() {
      calls.push({ interrupt: true })
    },
  }
  return {
    calls,
    entry,
    kernelCount: 1,
    status() {
      return { running: true, ready: true, busy: false, python: entry.python, executionState: 'idle', lastError: null }
    },
    async getOrStart(target, python, onEvent) {
      calls.push({ target, python })
      if (onEvent) onEvent({ type: 'status', phase: 'starting' })
      return entry
    },
    peek() {
      return entry
    },
    async interrupt() {
      calls.push({ interrupt: true })
    },
    async shutdown() {
      calls.push({ shutdown: true })
      return true
    },
    async restart() {
      calls.push({ restart: true })
    },
  }
}

async function invoke(ctx, kernels, req) {
  registerIpynbRoutes(ctx, kernels)
  const route = ctx.registered[0]
  assert.equal(route.path, '/ipynb')
  const { res, state } = makeRes()
  await route.handler(req, res)
  const text = Buffer.concat(state.chunks).toString('utf8')
  let json
  if (String(state.headers['content-type'] || '').includes('application/json') && text) {
    json = JSON.parse(text)
  }
  return { state, text, json }
}

test('health reports version, kernels and interpreter counts', async () => {
  const ctx = makeCtx()
  const { state, json } = await invoke(ctx, makeKernels(), makeReq())
  assert.equal(state.status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.value.version, packageJson.version)
  assert.equal(json.value.kernels, 1)
  assert.equal(typeof json.value.interpreters.checked, 'boolean')
  assert.equal(typeof json.value.interpreters.total, 'number')
})

test('interpreters lists discovered entries with a default', async () => {
  const { state, json } = await invoke(makeCtx(), makeKernels(), makeReq({ url: '/ipynb/interpreters' }))
  assert.equal(state.status, 200)
  assert.ok(Array.isArray(json.value.interpreters))
  assert.ok('default' in json.value)
})

test('unknown endpoints return not-found', async () => {
  const { state, json } = await invoke(makeCtx(), makeKernels(), makeReq({ url: '/ipynb/nope' }))
  assert.equal(state.status, 404)
  assert.equal(json.error.code, 'not-found')
})

test('wrong method returns 405 with allow', async () => {
  const { state, json } = await invoke(makeCtx(), makeKernels(), makeReq({ method: 'PUT', url: '/ipynb/read' }))
  assert.equal(state.status, 405)
  assert.equal(state.headers.allow, 'POST')
  assert.equal(json.error.code, 'method-not-allowed')
})

test('the host admission fence rejects requests before routing', async () => {
  const { state, json } = await invoke(makeCtx({ rejection: 403 }), makeKernels(), makeReq())
  assert.equal(state.status, 403)
  assert.equal(json.error.code, 'forbidden')
})

test('non-JSON POST bodies are rejected', async () => {
  const { state, json } = await invoke(
    makeCtx(),
    makeKernels(),
    makeReq({ method: 'POST', url: '/ipynb/read', body: { sessionId: 's1', path: 'x.ipynb' }, headers: { 'content-type': 'text/plain' } }),
  )
  assert.equal(state.status, 400)
  assert.equal(json.error.code, 'bad-request')
})

test('JSON Content-Type accepts parameters but rejects look-alike media types', async (t) => {
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  await writeFile(path.join(dir, 'demo.ipynb'), serializeNotebook(emptyNotebook()))
  for (const contentType of ['application/json; charset=utf-8', 'Application/JSON ; charset=UTF-8']) {
    const { state, json } = await invoke(
      makeCtx({ cwd: dir }),
      makeKernels(),
      makeReq({
        method: 'POST',
        url: '/ipynb/read',
        body: { sessionId: 's1', path: 'demo.ipynb' },
        headers: { 'content-type': contentType },
      }),
    )
    assert.equal(state.status, 200, contentType)
    assert.equal(json.ok, true, contentType)
  }
  for (const contentType of ['application/jsonp', 'application/jsonp; charset=utf-8']) {
    const { state, json } = await invoke(
      makeCtx({ cwd: dir }),
      makeKernels(),
      makeReq({
        method: 'POST',
        url: '/ipynb/read',
        body: { sessionId: 's1', path: 'demo.ipynb' },
        headers: { 'content-type': contentType },
      }),
    )
    assert.equal(state.status, 400, contentType)
    assert.equal(json.error.code, 'bad-request', contentType)
    assert.match(json.error.message, /Content-Type/)
  }
})

test('read rejects paths outside the session workspace', async (t) => {
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  const ctx = makeCtx({ cwd: dir })
  const { state, json } = await invoke(
    ctx,
    makeKernels(),
    makeReq({ method: 'POST', url: '/ipynb/read', body: { sessionId: 's1', path: '/etc/hosts' } }),
  )
  assert.equal(state.status, 403)
  assert.equal(json.error.code, 'path-outside-root')
})

test('read returns the parsed notebook and its version', async (t) => {
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  const file = path.join(dir, 'demo.ipynb')
  await writeFile(file, serializeNotebook(emptyNotebook()))
  const { state, json } = await invoke(
    makeCtx({ cwd: dir }),
    makeKernels(),
    makeReq({ method: 'POST', url: '/ipynb/read', body: { sessionId: 's1', path: 'demo.ipynb' } }),
  )
  assert.equal(state.status, 200)
  assert.equal(json.value.status, 'ok')
  assert.equal(json.value.version.length, 64)
  assert.equal(json.value.notebook.cells.length, 1)
})

test('save reports a write conflict for a stale baseVersion', async (t) => {
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  const file = path.join(dir, 'demo.ipynb')
  await writeFile(file, serializeNotebook(emptyNotebook()))
  const notebook = emptyNotebook()
  notebook.cells[0].source = '1 + 1'
  const { state, json } = await invoke(
    makeCtx({ cwd: dir }),
    makeKernels(),
    makeReq({
      method: 'POST',
      url: '/ipynb/save',
      body: { sessionId: 's1', path: 'demo.ipynb', notebook, baseVersion: '0'.repeat(64) },
    }),
  )
  assert.equal(state.status, 409)
  assert.equal(json.error.code, 'write-conflict')
  assert.equal(json.error.details.version.length, 64)
})

test('save writes a fresh version when baseVersion matches', async (t) => {
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  const file = path.join(dir, 'demo.ipynb')
  await writeFile(file, serializeNotebook(emptyNotebook()))
  const read = await invoke(
    makeCtx({ cwd: dir }),
    makeKernels(),
    makeReq({ method: 'POST', url: '/ipynb/read', body: { sessionId: 's1', path: 'demo.ipynb' } }),
  )
  const notebook = read.json.value.notebook
  notebook.cells[0].source = 'print(9)'
  const { state, json } = await invoke(
    makeCtx({ cwd: dir }),
    makeKernels(),
    makeReq({
      method: 'POST',
      url: '/ipynb/save',
      body: { sessionId: 's1', path: 'demo.ipynb', notebook, baseVersion: read.json.value.version },
    }),
  )
  assert.equal(state.status, 200)
  assert.notEqual(json.value.version, read.json.value.version)
})

test('save rejects malformed client notebooks without modifying the file', async (t) => {
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  const file = path.join(dir, 'demo.ipynb')
  const original = serializeNotebook(emptyNotebook())
  await writeFile(file, original)
  const baseVersion = sha256(Buffer.from(original))
  const malformed = [
    null,
    { nbformat: 4 },
    { nbformat: 4, cells: 'not-an-array' },
    { nbformat: 4, cells: [null] },
    { nbformat: 4, cells: [{ cell_type: 'invalid' }] },
    { nbformat: 3, cells: [] },
  ]
  for (const notebook of malformed) {
    const { state, json } = await invoke(
      makeCtx({ cwd: dir }),
      makeKernels(),
      makeReq({
        method: 'POST',
        url: '/ipynb/save',
        body: { sessionId: 's1', path: 'demo.ipynb', notebook, baseVersion },
      }),
    )
    assert.equal(state.status, 400, JSON.stringify(notebook))
    assert.equal(json.error.code, 'bad-request', JSON.stringify(notebook))
  }
  assert.equal(await readFile(file, 'utf8'), original)
  assert.deepEqual(await readdir(dir), ['demo.ipynb'])
})

test('save distinguishes bad requests and inaccessible paths from write conflicts', { skip: process.getuid?.() === 0 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bsb-ipynb-routes-'))
  await writeFile(path.join(dir, 'demo.ipynb'), serializeNotebook(emptyNotebook()))
  const ctx = makeCtx({ cwd: dir })
  try {
    const badNotebook = await invoke(ctx, makeKernels(), makeReq({
      method: 'POST',
      url: '/ipynb/save',
      body: { sessionId: 's1', path: 'demo.ipynb', notebook: {}, baseVersion: 'a'.repeat(64) },
    }))
    assert.equal(badNotebook.state.status, 400)
    assert.equal(badNotebook.json.error.code, 'bad-request')

    const protectedDir = path.join(dir, 'protected')
    await mkdir(protectedDir)
    await writeFile(path.join(protectedDir, 'p.ipynb'), serializeNotebook(emptyNotebook()))
    await chmod(protectedDir, 0o000)
    const denied = await invoke(ctx, makeKernels(), makeReq({
      method: 'POST',
      url: '/ipynb/save',
      body: { sessionId: 's1', path: 'protected/p.ipynb', notebook: emptyNotebook(), baseVersion: 'a'.repeat(64) },
    }))
    assert.equal(denied.state.status, 404)
    assert.equal(denied.json.error.code, 'not-found')
  } finally {
    try { await chmod(path.join(dir, 'protected'), 0o755) } catch { /* already gone */ }
    await rm(dir, { recursive: true, force: true })
  }
})

test('readJsonBody enforces its byte limit', async () => {
  const req = makeReq({ method: 'POST', url: '/ipynb/read', body: { sessionId: 's1', path: 'x.ipynb' } })
  await assert.rejects(readJsonBody(req, 4), (error) => error.code === 'too-large')
})

test('execute streams NDJSON events', async (t) => {
  const discovered = await discoverInterpreters()
  if (!discovered.default) {
    t.skip('no Python interpreter with jupyter_client/ipykernel')
    return
  }
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  await writeFile(path.join(dir, 'demo.ipynb'), serializeNotebook(emptyNotebook()))
  const kernels = makeKernels()
  const { state, text } = await invoke(
    makeCtx({ cwd: dir }),
    kernels,
    makeReq({
      method: 'POST',
      url: '/ipynb/execute',
      body: { sessionId: 's1', path: 'demo.ipynb', cellId: 'c1', code: 'print(1)' },
    }),
  )
  assert.equal(state.status, 200)
  assert.match(String(state.headers['content-type']), /application\/x-ndjson/)
  assert.equal(state.headers['x-accel-buffering'], 'no')
  assert.equal(state.headers['cache-control'], 'no-store')
  const events = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.ok(events.some((event) => event.type === 'stream' && event.text === 'hello\n'))
  assert.ok(events.some((event) => event.type === 'execute_reply' && event.ok === true))
  assert.equal(kernels.calls[0].python, discovered.default)
})

test('execute validates the notebook path before opening a stream', async (t) => {
  const base = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  const dir = path.join(base, 'session')
  await mkdir(dir)
  await writeFile(path.join(base, 'outside.ipynb'), serializeNotebook(emptyNotebook()))
  const { state, json } = await invoke(
    makeCtx({ cwd: dir }),
    makeKernels(),
    makeReq({
      method: 'POST',
      url: '/ipynb/execute',
      body: { sessionId: 's1', path: '../outside.ipynb', cellId: 'c1', code: '1' },
    }),
  )
  assert.equal(state.status, 403)
  assert.equal(json.error.code, 'path-outside-root')
})

test('interrupt needs a running kernel; shutdown without one is a no-op', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bsb-ipynb-routes-'))
  await writeFile(path.join(dir, 'demo.ipynb'), serializeNotebook(emptyNotebook()))
  const ctx = makeCtx({ cwd: dir })
  const makeKernelsWithoutKernel = () => {
    const kernels = makeKernels()
    kernels.peek = () => null
    return kernels
  }
  try {
    const interrupted = await invoke(
      ctx,
      makeKernelsWithoutKernel(),
      makeReq({ method: 'POST', url: '/ipynb/interrupt', body: { sessionId: 's1', path: 'demo.ipynb' } }),
    )
    assert.equal(interrupted.state.status, 503)
    assert.equal(interrupted.json.error.code, 'kernel-unavailable')

    const shutdown = await invoke(
      ctx,
      makeKernelsWithoutKernel(),
      makeReq({ method: 'POST', url: '/ipynb/shutdown', body: { sessionId: 's1', path: 'demo.ipynb' } }),
    )
    assert.equal(shutdown.state.status, 200, 'shutdown is idempotent when no kernel is running')
    assert.equal(shutdown.json.ok, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('execute waits for drain instead of dropping the final reply', async (t) => {
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  await writeFile(path.join(dir, 'demo.ipynb'), serializeNotebook(emptyNotebook()))
  const ctx = makeCtx({ cwd: dir })
  const kernels = makeKernels()
  registerIpynbRoutes(ctx, kernels)
  const handler = ctx.registered[0].handler
  const chunks = []
  const drainCallbacks = []
  let writes = 0
  let ended = false
  const res = {
    headersSent: false,
    writeHead() {
      this.headersSent = true
      return this
    },
    write(chunk) {
      chunks.push(String(chunk))
      writes += 1
      // Apply backpressure after the first chunk.
      return writes > 1
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk))
      ended = true
    },
    on() {
      return this
    },
    once(event, callback) {
      if (event === 'drain') drainCallbacks.push(callback)
      return this
    },
  }
  await handler(
    makeReq({
      method: 'POST',
      url: '/ipynb/execute',
      body: { sessionId: 's1', path: 'demo.ipynb', cellId: 'c1', code: '1 + 1' },
    }),
    res,
  )
  assert.ok(drainCallbacks.length > 0, 'route should wait for drain')
  for (const callback of drainCallbacks.splice(0)) callback()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ended, true)
  const events = chunks
    .join('')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.ok(events.some((event) => event.type === 'stream'))
  assert.ok(events.some((event) => event.type === 'execute_reply' && event.ok === true))
})

test('status, interrupt, restart and shutdown work after the notebook is deleted', async (t) => {
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  const file = path.join(dir, 'demo.ipynb')
  await writeFile(file, serializeNotebook(emptyNotebook()))
  const kernels = makeKernels()
  const ctx = makeCtx({ cwd: dir })
  await rm(file)

  const status = await invoke(
    ctx,
    kernels,
    makeReq({ url: '/ipynb/status?sessionId=s1&path=demo.ipynb' }),
  )
  assert.equal(status.state.status, 200)
  assert.equal(status.json.value.running, true, 'control status must find the kernel by path')

  for (const [url, expected] of [
    ['/ipynb/interrupt', { interrupt: true }],
    ['/ipynb/restart', { restart: true }],
    ['/ipynb/shutdown', { shutdown: true }],
  ]) {
    const { state, json } = await invoke(
      ctx,
      kernels,
      makeReq({
        method: 'POST',
        url,
        body: { sessionId: 's1', path: 'demo.ipynb' },
      }),
    )
    assert.equal(state.status, 200, url)
    assert.equal(json.ok, true, url)
    assert.ok(
      kernels.calls.some((call) => call[Object.keys(expected)[0]]),
      `${url} must reach the kernel`,
    )
  }
})

test('restart refuses a path that never existed when no kernel is running', async (t) => {
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  const kernels = makeKernels()
  kernels.peek = () => null
  const { state, json } = await invoke(
    makeCtx({ cwd: dir }),
    kernels,
    makeReq({
      method: 'POST',
      url: '/ipynb/restart',
      body: { sessionId: 's1', path: 'never-created.ipynb' },
    }),
  )
  assert.equal(state.status, 404)
  assert.equal(json.error.code, 'not-found')
  assert.equal(kernels.calls.length, 0, 'no kernel may be started for a path that never existed')
})

test('restart still starts a kernel for an existing notebook', async (t) => {
  const discovered = await discoverInterpreters()
  if (!discovered.default) {
    t.skip('no Python interpreter with jupyter_client/ipykernel')
    return
  }
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  await writeFile(path.join(dir, 'demo.ipynb'), serializeNotebook(emptyNotebook()))
  const kernels = makeKernels()
  kernels.peek = () => null
  const { state, json } = await invoke(
    makeCtx({ cwd: dir }),
    kernels,
    makeReq({
      method: 'POST',
      url: '/ipynb/restart',
      body: { sessionId: 's1', path: 'demo.ipynb' },
    }),
  )
  assert.equal(state.status, 200, JSON.stringify(json))
  assert.ok(
    kernels.calls.some((call) => call.python),
    'restart must start the kernel for an existing notebook',
  )
})

test('save rejects a notebook that grew past the cap on disk', async (t) => {
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  const file = path.join(dir, 'demo.ipynb')
  await writeFile(file, serializeNotebook(emptyNotebook()))
  await truncate(file, NOTEBOOK_CAP_BYTES + 1)
  const { state, json } = await invoke(
    makeCtx({ cwd: dir }),
    makeKernels(),
    makeReq({
      method: 'POST',
      url: '/ipynb/save',
      body: {
        sessionId: 's1',
        path: 'demo.ipynb',
        notebook: emptyNotebook(),
        baseVersion: '0'.repeat(64),
      },
    }),
  )
  assert.equal(state.status, 413)
  assert.equal(json.error.code, 'too-large')
})

test('execute does nothing when the client disconnects while the kernel starts', async (t) => {
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  await writeFile(path.join(dir, 'demo.ipynb'), serializeNotebook(emptyNotebook()))
  const kernels = makeKernels()
  let resolveStart
  let markStarted
  const startReached = new Promise((resolve) => {
    markStarted = resolve
  })
  kernels.getOrStart = (target, python) => {
    kernels.calls.push({ target, python })
    markStarted()
    return new Promise((resolve) => {
      resolveStart = () => resolve(kernels.entry)
    })
  }
  const ctx = makeCtx({ cwd: dir })
  registerIpynbRoutes(ctx, kernels)
  const handler = ctx.registered[0].handler
  const { res } = trackedRes()
  const pending = handler(
    makeReq({
      method: 'POST',
      url: '/ipynb/execute',
      body: { sessionId: 's1', path: 'demo.ipynb', cellId: 'c1', code: 'print(1)' },
    }),
    res,
  )
  await startReached
  res.emit('close')
  resolveStart()
  await pending
  assert.equal(kernels.calls.filter((call) => call.cellId).length, 0, 'dead client must not run the cell')
  assert.equal(kernels.calls.filter((call) => call.interrupt).length, 0)
})

test('execute interrupts an active run when the client disconnects', async (t) => {
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  await writeFile(path.join(dir, 'demo.ipynb'), serializeNotebook(emptyNotebook()))
  const kernels = makeKernels()
  let resumeRun
  let markRunStarted
  const runReached = new Promise((resolve) => {
    markRunStarted = resolve
  })
  kernels.entry.run = async (cellId, code) => {
    kernels.calls.push({ cellId, code })
    markRunStarted()
    await new Promise((resolve) => {
      resumeRun = resolve
    })
    return { type: 'execute_reply', cell_id: cellId, ok: false }
  }
  const ctx = makeCtx({ cwd: dir })
  registerIpynbRoutes(ctx, kernels)
  const handler = ctx.registered[0].handler
  const { res } = trackedRes()
  const pending = handler(
    makeReq({
      method: 'POST',
      url: '/ipynb/execute',
      body: { sessionId: 's1', path: 'demo.ipynb', cellId: 'c1', code: 'while True: pass' },
    }),
    res,
  )
  await runReached
  res.emit('close')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(kernels.calls.filter((call) => call.interrupt).length, 1)
  resumeRun()
  await pending
})

test('a close after a normal execute does not interrupt the kernel', async (t) => {
  const dir = await tempDir(t, 'dsh-bsb-ipynb-routes-')
  await writeFile(path.join(dir, 'demo.ipynb'), serializeNotebook(emptyNotebook()))
  const kernels = makeKernels()
  const ctx = makeCtx({ cwd: dir })
  registerIpynbRoutes(ctx, kernels)
  const handler = ctx.registered[0].handler
  const { res } = trackedRes()
  await handler(
    makeReq({
      method: 'POST',
      url: '/ipynb/execute',
      body: { sessionId: 's1', path: 'demo.ipynb', cellId: 'c1', code: 'print(1)' },
    }),
    res,
  )
  res.emit('close')
  assert.equal(kernels.calls.filter((call) => call.interrupt).length, 0)
})
