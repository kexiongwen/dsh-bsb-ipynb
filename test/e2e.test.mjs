import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { KernelManager } from '../lib/kernel.js'
import { emptyNotebook } from '../lib/notebook.js'
import { discoverInterpreters } from '../lib/env.js'
import { registerIpynbRoutes } from '../lib/routes.js'
import { findPython } from './python-helper.mjs'

const python = findPython('jupyter_client, ipykernel')
const hasJupyter = Boolean(python)
const bridgePath = fileURLToPath(new URL('../python/bridge.py', import.meta.url))

function makeResponse() {
  const chunks = []
  return {
    statusCode: 0,
    headers: null,
    headersSent: false,
    ended: false,
    chunks,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = headers
      this.headersSent = true
      return this
    },
    write(chunk) {
      chunks.push(String(chunk))
      return true
    },
    end(body) {
      if (body !== undefined) chunks.push(String(body))
      this.ended = true
    },
    on() {},
  }
}

function makeRequest(payload, url) {
  const stream = Readable.from([Buffer.from(JSON.stringify(payload))])
  stream.url = url
  stream.method = 'POST'
  stream.headers = { 'content-type': 'application/json' }
  return stream
}

async function invoke(handler, payload, url) {
  const res = makeResponse()
  await handler(makeRequest(payload, url), res)
  return res
}

function parseNdjson(chunks) {
  return chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('execute route streams a real kernel run to completion', {
  skip: !hasJupyter && 'Requires jupyter_client/ipykernel',
  timeout: 60_000,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bsb-ipynb-e2e-'))
  const notebookPath = path.join(dir, 'e2e.ipynb')
  await writeFile(notebookPath, JSON.stringify(emptyNotebook()), 'utf8')
  let handler = null
  const ctx = {
    sessions: { get: (id) => (id === 'session-e2e' ? { header: { cwd: dir } } : undefined) },
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route) {
        handler = route.handler
        return () => {}
      },
    },
  }
  const kernels = new KernelManager(ctx, bridgePath)
  try {
    registerIpynbRoutes(ctx, kernels)
    assert.equal(typeof handler, 'function')

    const read = await invoke(handler, { sessionId: 'session-e2e', path: 'e2e.ipynb' }, '/ipynb/read')
    const readEnvelope = JSON.parse(read.chunks.join(''))
    assert.equal(readEnvelope.ok, true)
    assert.equal(readEnvelope.value.status, 'ok')

    const executed = await invoke(
      handler,
      { sessionId: 'session-e2e', path: 'e2e.ipynb', cellId: 'cell-e2e', code: 'print("e2e")\n1 + 1' },
      '/ipynb/execute',
    )
    assert.equal(executed.statusCode, 200)
    assert.match(executed.headers['content-type'], /application\/x-ndjson/)
    const events = parseNdjson(executed.chunks)
    assert.ok(events.some((event) => event.type === 'stream' && event.text.includes('e2e')))
    const result = events.find((event) => event.type === 'execute_result')
    assert.ok(result, 'execute_result event')
    assert.equal(String(result.data['text/plain']), '2')
    const reply = events.find((event) => event.type === 'execute_reply')
    assert.ok(reply, 'execute_reply event')
    assert.equal(reply.ok, true)
    assert.ok(executed.ended)

    const statusRequest = Readable.from([])
    statusRequest.url = '/ipynb/status?sessionId=session-e2e&path=e2e.ipynb'
    statusRequest.method = 'GET'
    statusRequest.headers = {}
    const status = makeResponse()
    await handler(statusRequest, status)
    const statusEnvelope = JSON.parse(status.chunks.join(''))
    assert.equal(statusEnvelope.ok, true)
    assert.equal(statusEnvelope.value.running, true)
    const reportedPython = statusEnvelope.value.python
    assert.equal(typeof reportedPython, 'string')
    assert.equal(path.isAbsolute(reportedPython), true, 'status reports an absolute interpreter path')
    assert.equal(existsSync(reportedPython), true, 'the reported interpreter exists on disk')
    assert.equal(reportedPython, (await discoverInterpreters()).default)
  } finally {
    await kernels.disposeAll()
    await rm(dir, { recursive: true, force: true })
  }
})
