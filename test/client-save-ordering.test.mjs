import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClient } from './client-harness.mjs'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value }
}

function success(value) {
  return response({ ok: true, value })
}

async function settle() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

async function fixture(t) {
  const { exports } = await loadClient()
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => {
    const request = { url, body: JSON.parse(init.body), ...deferred() }
    requests.push(request)
    return request.promise
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const makeContext = (origin = 'http://host') => {
    const ctx = {
      effect(effect) { return effect() },
      betterSidebar: { version: '0.32.1', features: ['hostRouteUrl'],
        hostRouteUrl: (route) => origin + '/' + route,
        registerFileViewer(viewer) { ctx.viewer = viewer; return () => {} },
      },
    }
    exports.apply(ctx)
    return ctx
  }
  const ctx = makeContext()
  const path = '/workspace/demo.ipynb'
  const scope = { sessionId: 'session-1' }
  const postSave = (options = {}) => exports.__test.postJson(options.ctx || ctx, 'save', {
    path: options.path || path,
    sessionId: options.sessionId || scope.sessionId,
    notebook: { cells: [] },
    baseVersion: 'v1',
  }).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  )
  const reads = () => requests.filter((request) => request.url.endsWith('/read'))
  const saves = () => requests.filter((request) => request.url.endsWith('/save'))
  return { exports, ctx, makeContext, path, scope, postSave, reads, saves }
}

for (const outcome of ['success', 'conflict', 'network failure']) {
  test(`registered host loader waits for a previous viewer's save ${outcome}`, async (t) => {
    const f = await fixture(t)
    const saving = f.postSave()
    // A replacement viewer has no access to the old component's savingRef.
    // Its host loader still shares the request lifecycle at module scope.
    const replacementContext = f.makeContext()
    const reading = replacementContext.viewer.load(f.path, f.scope)
    await settle()
    assert.equal(f.reads().length, 0, 'refresh cannot overtake the accepted save')
    if (outcome === 'success') f.saves()[0].resolve(success({ version: 'v2' }))
    else if (outcome === 'conflict') f.saves()[0].resolve(response({
      ok: false, error: { code: 'write-conflict', message: 'conflict', details: { version: 'v2' } },
    }, 409))
    else f.saves()[0].reject(new Error('network failure'))
    const result = await saving
    assert.equal(result.status, outcome === 'success' ? 'fulfilled' : 'rejected')
    await settle()
    assert.equal(f.reads().length, 1, 'every settled outcome releases the refresh')
    f.reads()[0].resolve(success({ status: 'ok', version: 'v2', notebook: { cells: [] } }))
    assert.equal((await reading).version, 'v2')
    const again = replacementContext.viewer.load(f.path, f.scope)
    assert.equal(f.reads().length, 2, 'settled saves leave no retained wait')
    f.reads()[1].resolve(success({ status: 'ok', version: 'v2', notebook: { cells: [] } }))
    await again
  })
}

test('a save remains pending until its JSON response is parsed', async (t) => {
  const f = await fixture(t)
  const saving = f.postSave()
  const parsing = deferred()
  f.saves()[0].resolve({ ok: true, status: 200, json: () => parsing.promise })
  await settle()
  const reading = f.ctx.viewer.load(f.path, f.scope)
  await settle()
  assert.equal(f.reads().length, 0)
  parsing.resolve({ ok: true, value: { version: 'v2' } })
  await saving
  await settle()
  assert.equal(f.reads().length, 1)
  f.reads()[0].resolve(success({ status: 'ok', version: 'v2' }))
  await reading
})

test('pending saves are isolated by host, session and path', async (t) => {
  const f = await fixture(t)
  const saving = f.postSave()
  const otherHost = f.makeContext('http://other-host')
  const reads = [
    f.ctx.viewer.load('/workspace/other.ipynb', f.scope),
    f.ctx.viewer.load(f.path, { sessionId: 'other-session' }),
    otherHost.viewer.load(f.path, f.scope),
  ]
  assert.equal(f.reads().length, 3, 'unrelated documents remain independent')
  for (const request of f.reads()) request.resolve(success({ status: 'ok', version: 'independent' }))
  await Promise.all(reads)
  f.saves()[0].resolve(success({ version: 'v2' }))
  await saving
})

test('a host refresh waits for every save, including a save added while waiting', async (t) => {
  const f = await fixture(t)
  const first = f.postSave()
  const reading = f.ctx.viewer.load(f.path, f.scope)
  const second = f.postSave()
  f.saves()[0].resolve(success({ version: 'v2' }))
  await first
  await settle()
  assert.equal(f.reads().length, 0, 'one settled request cannot release another save')
  f.saves()[1].resolve(response({ ok: false, error: { code: 'write-conflict' } }, 409))
  await second
  await settle()
  assert.equal(f.reads().length, 1)
  f.reads()[0].resolve(success({ status: 'ok', version: 'v2' }))
  await reading
})

for (const failure of [false, true]) {
  test(`a ${failure ? 'failed' : 'successful'} read overtaken by a save is retried even after the save settled`, async (t) => {
    const f = await fixture(t)
    const reading = f.ctx.viewer.load(f.path, f.scope)
    assert.equal(f.reads().length, 1)
    const saving = f.postSave()
    f.saves()[0].resolve(success({ version: 'v2' }))
    await saving
    if (failure) f.reads()[0].reject(new Error('old read failed'))
    else f.reads()[0].resolve(success({ status: 'ok', version: 'v1' }))
    await settle()
    assert.equal(f.reads().length, 2, 'the superseded read cannot become the adopted baseline')
    f.reads()[1].resolve(success({ status: 'ok', version: 'v2' }))
    assert.equal((await reading).version, 'v2')
  })
}

test('a read overtaken by an unsettled save waits before retrying', async (t) => {
  const f = await fixture(t)
  const reading = f.ctx.viewer.load(f.path, f.scope)
  const saving = f.postSave()
  f.reads()[0].resolve(success({ status: 'ok', version: 'v1' }))
  await settle()
  assert.equal(f.reads().length, 1)
  f.saves()[0].resolve(success({ version: 'v2' }))
  await saving
  await settle()
  assert.equal(f.reads().length, 2)
  f.reads()[1].resolve(success({ status: 'ok', version: 'v2' }))
  assert.equal((await reading).version, 'v2')
})

test('aborting a host refresh releases its wait without aborting the save', async (t) => {
  const f = await fixture(t)
  const saving = f.postSave()
  const controller = new AbortController()
  const reading = f.ctx.viewer.load(f.path, f.scope, controller.signal)
  const aborted = assert.rejects(reading, (error) => error.name === 'AbortError')
  controller.abort()
  await aborted
  assert.equal(f.reads().length, 0)
  const replacement = f.ctx.viewer.load(f.path, f.scope)
  await settle()
  assert.equal(f.reads().length, 0, 'the write is still tracked after the abandoned read')
  f.saves()[0].resolve(success({ version: 'v2' }))
  assert.equal((await saving).status, 'fulfilled')
  await settle()
  assert.equal(f.reads().length, 1)
  f.reads()[0].resolve(success({ status: 'ok', version: 'v2' }))
  await replacement
})

test('aborted transports and ordinary read errors leave later loads usable', async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  const reading = f.ctx.viewer.load(f.path, f.scope, controller.signal)
  const aborted = assert.rejects(reading, (error) => error.name === 'AbortError')
  controller.abort()
  f.reads()[0].resolve(success({ status: 'ok', version: 'stale' }))
  await aborted
  const failed = f.ctx.viewer.load(f.path, f.scope)
  f.reads()[1].reject(new Error('temporary read failure'))
  assert.deepEqual(await failed, { status: 'error', code: 'network', message: 'temporary read failure' })
  const next = f.ctx.viewer.load(f.path, f.scope)
  f.reads()[2].resolve(success({ status: 'ok', version: 'fresh' }))
  assert.equal((await next).version, 'fresh')
})
