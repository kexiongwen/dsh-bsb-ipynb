import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

// Keep the actual discovery/route code, controlling only the Python probe.
// This file runs in its own node:test process and needs no Python or Jupyter.
let probeGate = null
const originalExecFile = childProcess.execFile
const mockExecFile = () => { throw new Error('Unexpected callback-style interpreter probe') }
mockExecFile[promisify.custom] = async () => {
  if (probeGate) await probeGate.wait()
  return {
    stdout: JSON.stringify({ ok: true, version: '3.14', jupyter_client: 'test', ipykernel: 'test' }),
    stderr: '',
  }
}
let registerIpynbRoutes
let resetInterpreterCache
try {
  childProcess.execFile = mockExecFile
  syncBuiltinESMExports()
  ;({ registerIpynbRoutes } = await import('../lib/routes.js'))
  ;({ resetInterpreterCache } = await import('../lib/env.js'))
} finally {
  childProcess.execFile = originalExecFile
  syncBuiltinESMExports()
}

function gate() {
  let reached
  let release
  const entered = new Promise((resolve) => { reached = resolve })
  const pending = new Promise((resolve) => { release = resolve })
  return { entered, release, async wait() { reached(); await pending } }
}

async function within(promise) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Controlled route stage was not reached')), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function response() {
  const res = new EventEmitter()
  Object.assign(res, {
    headersSent: false,
    destroyed: false,
    ended: false,
    status: 0,
    chunks: [],
    writeHead(status) { this.status = status; this.headersSent = true; return this },
    write(chunk) { this.chunks.push(String(chunk)); return true },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(String(chunk))
      this.ended = true
    },
    disconnect(event = 'close') {
      this.destroyed = true
      this.emit(event, event === 'error' ? new Error('Controlled response failure') : undefined)
    },
  })
  // A host may have its own error listener. It must not substitute for the
  // plugin's disconnect bookkeeping, including before /execute starts.
  res.on('error', () => {})
  return res
}

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-execute-disconnect-'))
  const notebookPath = path.join(directory, 'demo.ipynb')
  await fs.writeFile(notebookPath, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }))
  const priorPython = process.env.DSH_IPYNB_PYTHON
  process.env.DSH_IPYNB_PYTHON = process.execPath
  resetInterpreterCache()
  const calls = []
  let startGate = null
  let runGate = null
  let runSignal
  let runHandler = null
  let started = false
  const entry = {
    async run(cellId, code, onEvent, options) {
      calls.push({ operation: 'run', cellId, code })
      runSignal = options?.signal
      if (runHandler) return runHandler({ cellId, code, onEvent, signal: runSignal })
      if (runGate) await runGate.wait()
      onEvent({ type: 'stream', cell_id: cellId, name: 'stdout', text: 'result\n' })
      const reply = { type: 'execute_reply', cell_id: cellId, ok: true }
      onEvent(reply)
      return reply
    },
  }
  const kernels = {
    peek() { return started ? entry : null },
    async getOrStart() {
      calls.push({ operation: 'start' })
      if (startGate) await startGate.wait()
      started = true
      return entry
    },
    async interrupt() { calls.push({ operation: 'interrupt' }) },
  }
  let handler
  registerIpynbRoutes({
    sessions: { get: () => ({ header: { cwd: directory } }) },
    connection: { requestRejection: () => undefined },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }, kernels)
  t.after(async () => {
    startGate?.release()
    runGate?.release()
    probeGate?.release()
    probeGate = null
    if (priorPython === undefined) delete process.env.DSH_IPYNB_PYTHON
    else process.env.DSH_IPYNB_PYTHON = priorPython
    resetInterpreterCache()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return {
    notebookPath,
    calls,
    handler,
    get runSignal() { return runSignal },
    holdStart(value) { startGate = value },
    holdRun(value) { runGate = value },
    duringRun(handler) { runHandler = handler },
    request(bodyGate = null) {
      return {
        method: 'POST',
        url: '/ipynb/execute',
        headers: { 'content-type': 'application/json' },
        async *[Symbol.asyncIterator]() {
          if (bodyGate) await bodyGate.wait()
          yield Buffer.from(JSON.stringify({ sessionId: 's1', path: 'demo.ipynb', cellId: 'cell', code: 'SIDE_EFFECT()' }))
        },
      }
    },
  }
}

for (const stage of ['body read', 'path resolution', 'interpreter discovery']) {
  for (const event of ['close', 'error']) {
    test(`execute does not start after response ${event} during ${stage}`, async (t) => {
      const h = await setup(t)
      const held = gate()
      t.after(() => held.release())
      if (stage === 'path resolution') {
        const realpath = fs.realpath
        t.mock.method(fs, 'realpath', async (target, ...args) => {
          if (path.basename(String(target)) === 'demo.ipynb') await held.wait()
          return realpath(target, ...args)
        })
      } else if (stage === 'interpreter discovery') {
        probeGate = held
      }
      const res = response()
      const pending = h.handler(h.request(stage === 'body read' ? held : null), res)
      await within(held.entered)
      res.disconnect(event)
      held.release()
      await within(pending)
      assert.deepEqual(h.calls, [], 'a dead request must neither start a kernel nor submit a cell')
    })
  }
}

test('execute does not start when the response was destroyed before handler registration', async (t) => {
  const h = await setup(t)
  const res = response()
  res.disconnect()
  await within(h.handler(h.request(), res))
  assert.deepEqual(h.calls, [])
})

test('execute still streams a connected request to completion', async (t) => {
  const h = await setup(t)
  const res = response()
  await within(h.handler(h.request(), res))
  assert.deepEqual(h.calls.map((call) => call.operation), ['start', 'run'])
  assert.equal(res.status, 200)
  assert.equal(res.ended, true)
  const events = res.chunks.join('').trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(events.some((event) => event.type === 'stream' && event.text === 'result\n'))
  assert.ok(events.some((event) => event.type === 'execute_reply' && event.ok))
  res.disconnect()
  assert.equal(h.calls.some((call) => call.operation === 'interrupt'), false)
})

test('execute does not submit a cell after disconnect during kernel startup', async (t) => {
  const h = await setup(t)
  const held = gate()
  h.holdStart(held)
  const res = response()
  const pending = h.handler(h.request(), res)
  await within(held.entered)
  res.disconnect()
  held.release()
  await within(pending)
  assert.deepEqual(h.calls.map((call) => call.operation), ['start'])
})

test('execute still interrupts a running cell when the response closes', async (t) => {
  const h = await setup(t)
  const held = gate()
  h.holdRun(held)
  const res = response()
  const pending = h.handler(h.request(), res)
  await within(held.entered)
  res.disconnect()
  held.release()
  await within(pending)
  assert.deepEqual(h.calls.map((call) => call.operation), ['start', 'run', 'interrupt'])
})

test('execute does not start when writing response headers synchronously closes the response', async (t) => {
  const h = await setup(t)
  const res = response()
  const writeHead = res.writeHead
  res.writeHead = function (status) {
    writeHead.call(this, status)
    this.disconnect()
    return this
  }
  await within(h.handler(h.request(), res))
  assert.deepEqual(h.calls, [])
})

test('execute does not start when the initial status write throws without a close event', async (t) => {
  const h = await setup(t)
  const res = response()
  let writes = 0
  res.write = () => {
    writes += 1
    throw new Error('Controlled write failure')
  }
  await within(h.handler(h.request(), res))
  assert.equal(writes, 1)
  assert.deepEqual(h.calls, [])
})

test('response error followed by close interrupts the current execution only once', async (t) => {
  const h = await setup(t)
  const held = gate()
  h.holdRun(held)
  const res = response()
  const pending = h.handler(h.request(), res)
  await within(held.entered)
  res.disconnect('error')
  res.disconnect('close')
  held.release()
  await within(pending)
  assert.deepEqual(h.calls.map((call) => call.operation), ['start', 'run', 'interrupt'])
})

test('execute passes a live cancellation signal and aborts it when the response disconnects', async (t) => {
  const h = await setup(t)
  const held = gate()
  h.holdRun(held)
  const res = response()
  const pending = h.handler(h.request(), res)
  await within(held.entered)
  assert.ok(h.runSignal instanceof AbortSignal)
  assert.equal(h.runSignal.aborted, false)
  res.disconnect('close')
  assert.equal(h.runSignal.aborted, true)
  res.disconnect('error')
  held.release()
  await within(pending)
  assert.deepEqual(h.calls.map((call) => call.operation), ['start', 'run', 'interrupt'])
})

test('normal request-body close and destroyed state do not cancel the live response', async (t) => {
  const h = await setup(t)
  const source = h.request()
  const req = Object.assign(new EventEmitter(), source)
  req.aborted = false
  req[Symbol.asyncIterator] = async function* () {
    for await (const chunk of source) yield chunk
    // Node can destroy/close a fully consumed IncomingMessage while its
    // ServerResponse remains open and the cell still needs to execute.
    this.destroyed = true
    this.emit('close')
  }
  const res = response()
  await within(h.handler(req, res))
  assert.equal(req.destroyed, true)
  assert.deepEqual(h.calls.map((call) => call.operation), ['start', 'run'])
  assert.equal(res.ended, true)
})

for (const stage of ['before handling', 'during body read']) {
  test(`an explicitly aborted request does not start execution ${stage}`, async (t) => {
    const h = await setup(t)
    const held = gate()
    t.after(() => held.release())
    const req = h.request(stage === 'during body read' ? held : null)
    const res = response()
    if (stage === 'before handling') req.aborted = true
    const pending = h.handler(req, res)
    if (stage === 'during body read') {
      await within(held.entered)
      req.aborted = true
      held.release()
    }
    await within(pending)
    assert.deepEqual(h.calls, [])
  })
}

for (const throwsOnEnd of [false, true]) {
  test(`output queue overflow cancels before ending the response${throwsOnEnd ? ', even when end throws' : ''}`, async (t) => {
    const h = await setup(t)
    const held = gate()
    const res = response()
    const ended = []
    let writes = 0
    let aborts = 0
    let pending
    const interrupts = () => h.calls.filter((call) => call.operation === 'interrupt').length
    // Block the initial status write. Real stream frames then accumulate in
    // the route's queue; each is well below the bridge's per-line limit.
    res.write = () => { writes += 1; return false }
    res.end = (chunk) => {
      ended.push({ event: JSON.parse(String(chunk)), aborted: h.runSignal.aborted, interrupts: interrupts() })
      res.ended = true
      // Deliberately emit neither close nor error and do not alter the flags
      // observed by isDisconnected: cancellation must precede end itself.
      if (throwsOnEnd) throw new Error('Controlled end failure')
    }
    h.duringRun(async ({ cellId, onEvent, signal }) => {
      signal.addEventListener('abort', () => {
        aborts += 1
        // Abort listeners run synchronously. Re-entering the writer and the
        // response callbacks must observe cancellation already in progress.
        onEvent({ type: 'stream', cell_id: cellId, name: 'stdout', text: 'late abort output' })
        res.emit('drain')
        res.emit('error', new Error('Response error during abort'))
      })
      const text = 'x'.repeat(17 * 1024 * 1024)
      for (let index = 0; index < 4; index += 1) {
        onEvent({ type: 'stream', cell_id: cellId, name: 'stdout', text })
      }
      // No more kernel output: the assertion below cannot be rescued by a
      // later write, a response-close callback, or the 15-second heartbeat.
      await held.wait()
      return { type: 'execute_reply', cell_id: cellId, ok: false }
    })
    t.after(async () => {
      held.release()
      if (pending) await within(pending)
    })
    pending = h.handler(h.request(), res)
    await within(held.entered)
    assert.equal(ended.length, 1, 'overflow must attempt exactly one terminal response')
    assert.equal(ended[0].event.type, 'fatal')
    assert.equal(ended[0].event.code, 'output-too-large')
    assert.equal(ended[0].aborted, true, 'the execution signal must already be aborted inside res.end')
    assert.equal(ended[0].interrupts, 1, 'the running kernel must already be interrupted inside res.end')
    assert.equal(h.runSignal.aborted, true)
    assert.equal(aborts, 1)
    assert.equal(interrupts(), 1)
    assert.equal(writes, 1, 'only the initial status reached the backpressured response')

    for (const event of ['drain', 'error', 'close', 'drain']) {
      res.emit(event, event === 'error' ? new Error('Late response failure') : undefined)
    }
    held.release()
    await within(pending)
    res.emit('close')
    assert.equal(aborts, 1, 'late response events must not cancel twice')
    assert.equal(interrupts(), 1, 'late response events must not interrupt twice')
    assert.equal(ended.length, 1, 'late events must not send another fatal or end')
    assert.equal(writes, 1, 'late drains must not flush discarded output')
  })
}
