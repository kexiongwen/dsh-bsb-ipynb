import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

function notebookData(output = 'OLD', version = 'v1') {
  return {
    status: 'ok', version,
    notebook: {
      nbformat: 4, nbformat_minor: 5, metadata: {},
      cells: [{
        id: 'cell-1', cell_type: 'code', source: 'print("old")', metadata: {}, execution_count: 1,
        outputs: [{ output_type: 'stream', name: 'stdout', text: output }],
      }],
    },
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function settleWithoutCommit() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value }
}

function executionStream() {
  let controller
  const body = new ReadableStream({ start(value) { controller = value } })
  return {
    response: { ok: true, status: 200, body },
    emit(event) {
      // HTTP readers receive chunks, not necessarily complete NDJSON lines.
      // Keep transport allocations bounded even in the real 32 MiB tests.
      const line = JSON.stringify(event) + '\n'
      for (let start = 0; start < line.length;) {
        let end = Math.min(start + 1024 * 1024, line.length)
        const tail = line.charCodeAt(end - 1)
        if (end < line.length && tail >= 0xd800 && tail <= 0xdbff) end -= 1
        controller.enqueue(new TextEncoder().encode(line.slice(start, end)))
        start = end
      }
    },
    end() { controller.close() },
    fail(error = new Error('connection lost')) { controller.error(error) },
  }
}

function findElement(tree, predicate) {
  const pending = [tree]
  while (pending.length) {
    const element = pending.shift()
    if (!element || typeof element !== 'object') continue
    if (Array.isArray(element)) { pending.push(...element); continue }
    if (predicate(element)) return element
    pending.push(...(element.props?.children || []))
  }
  return null
}

// Exercise the actual component and callbacks without adding a React renderer
// dependency. Hook slots are allocated normally; no test knows their indexes.
// State updates (including functional updaters) are queued until render. Effects
// run after each commit, honor dependencies, and clean up on replacement and
// unmount. Timers remain controllable so autosave cannot race the assertions.
function mountNotebook(t) {
  const slots = []
  const timers = new Map()
  const requests = []
  let cursor = 0, nextTimer = 0, needsRender = true, mounted = true
  let pendingEffects = [], pendingState = [], tree, moduleOptions, hostReloads = 0
  let props = {
    ctx: { betterSidebar: { hostRouteUrl: (route) => 'http://host/' + route } },
    scope: { sessionId: 'session-1' }, path: '/workspace/demo.ipynb', visible: false,
    customData: notebookData(), onReload() { hostReloads += 1 },
  }
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const memo = (factory, deps) => {
    const index = cursor++
    if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: factory(), deps }
    return slots[index].value
  }
  const react = {
    createElement: (type, properties, ...children) => ({ type, props: { ...properties, children } }),
    Fragment: 'fragment',
    useState(initial) {
      const index = cursor++
      if (!slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial }
        slot.set = (next) => {
          if (!mounted) return
          pendingState.push([slot, next])
          needsRender = true
        }
        slots[index] = slot
      }
      return [slots[index].value, slots[index].set]
    },
    useRef(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: { current: initial } }
      return slots[index].value
    },
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect(effect, deps) {
      const index = cursor++
      const previous = slots[index]
      if (previous && sameDeps(previous.deps, deps)) return
      slots[index] = { deps, cleanup: previous?.cleanup }
      pendingEffects.push(() => {
        slots[index].cleanup?.()
        slots[index].cleanup = effect()
      })
    },
  }
  const fetch = (url, init = {}) => {
    const route = new URL(url).pathname.split('/').pop()
    if (route === 'interpreters') return Promise.resolve(response({ ok: true, value: { interpreters: [{ ok: true, path: '/python' }], default: '/python' } }))
    if (route === 'status') return Promise.resolve(response({ ok: true, value: { running: false, ready: false, busy: false, python: null, executionState: 'none' } }))
    const result = deferred()
    // Deliberately allow responses after abort: a queued response or transport
    // that already completed must still be rejected by the document generation.
    requests.push({ route, init, body: init.body ? JSON.parse(init.body) : undefined, ...result })
    return result.promise
  }
  const context = vm.createContext({
    window: {
      __ModuleLoader__: { load(options) { moduleOptions = options } },
      localStorage: { getItem() { return null }, setItem() {} }, confirm() { return true },
    },
    navigator: { language: 'en-US' },
    URLSearchParams, TextDecoder, TextEncoder, AbortController, fetch,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    setInterval(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearInterval(id) { timers.delete(id) },
  })
  vm.runInContext(clientSource, context, { filename: 'client.js' })
  const { NotebookView } = moduleOptions.factory(() => react).__test
  function flush() {
    let commits = 0
    while (needsRender) {
      assert.ok(++commits < 30, 'component effects must settle')
      needsRender = false
      for (const [slot, next] of pendingState.splice(0)) {
        slot.value = typeof next === 'function' ? next(slot.value) : next
      }
      cursor = 0
      pendingEffects = []
      tree = NotebookView(props)
      pendingEffects.forEach((effect) => effect())
    }
  }
  async function settle() {
    // Drain fetch/json/reader promise chains, with commits between microtasks.
    for (let i = 0; i < 8; i += 1) { await Promise.resolve(); flush() }
    await new Promise((resolve) => setImmediate(resolve))
    flush()
  }
  const component = (name) => {
    flush()
    const element = findElement(tree, (value) => value.type?.name === name)
    assert.ok(element, name + ' is rendered')
    return element
  }
  const api = {
    flush, settle,
    get toolbar() { return component('Toolbar').props },
    get cell() { return component('CellView').props },
    get banner() { return component('Banner').props.banner },
    requests: (route) => requests.filter((request) => request.route === route),
    edit(source = 'print("edited")') { api.cell.onSource('cell-1', source); flush() },
    run() { api.cell.onRun('cell-1'); flush(); return api.requests('execute').at(-1) },
    runWithoutCommit() { api.cell.onRun('cell-1'); return api.requests('execute').at(-1) },
    save() { api.toolbar.onSave(); flush(); return api.requests('save').at(-1) },
    reload(data = notebookData('FRESH', 'v2')) {
      api.toolbar.onReload()
      assert.ok(hostReloads > 0, 'reload delegates to the host')
      props = { ...props, customData: data }
      needsRender = true
      flush()
    },
    cancelReload() { api.toolbar.onReload(); flush() },
    saveButton() {
      const toolbar = component('Toolbar')
      return findElement(toolbar.type(toolbar.props), (value) => value.props?.title === 'Save').props
    },
  }
  t.after(() => {
    mounted = false
    for (const slot of slots) slot?.cleanup?.()
    timers.clear()
    // Release the unmounted fixture's component and transport state before
    // another real-cap case allocates its large output payloads.
    slots.length = 0
    requests.length = 0
    pendingState = []
    pendingEffects = []
    tree = null
    props = null
  })
  flush()
  return api
}

for (const edited of [false, true]) {
  test(`running cells reject toolbar and shortcut saves; failed run restores outputs and dirty=${edited}`, async (t) => {
    const app = mountNotebook(t)
    await app.settle()
    if (edited) app.edit()
    const request = app.run()
    const stream = executionStream()
    request.resolve(stream.response)
    await app.settle()
    assert.equal(app.saveButton().disabled, true)
    app.save()
    app.cell.onSave()
    await app.settle()
    assert.equal(app.requests('save').length, 0, 'neither save entry point writes cleared or partial output')
    stream.emit({ type: 'fatal', message: 'connection lost' })
    stream.end()
    await app.settle()
    assert.equal(app.cell.cell.outputs[0].text, 'OLD')
    assert.equal(app.cell.cell.execution_count, 1)
    assert.equal(app.toolbar.dirty, edited, 'restoring an unchanged snapshot preserves its original dirty state')
  })
}

test('reload invalidates an old execution before late output, status, errors and replies arrive', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  const request = app.run()
  const stream = executionStream()
  request.resolve(stream.response)
  await app.settle()
  app.reload()
  assert.equal(request.init.signal.aborted, true, 'successful adoption aborts the old execution')
  const kernelAfterReload = JSON.stringify(app.toolbar.kernel)
  for (const event of [
    { type: 'stream', text: 'STALE' },
    { type: 'status', execution_state: 'busy' },
    { type: 'error', ename: 'OldError', evalue: 'STALE', traceback: ['STALE'] },
    { type: 'fatal', message: 'STALE FATAL' },
    { type: 'execute_reply', ok: true, execution_count: 99 },
  ]) {
    stream.emit({ cell_id: 'cell-1', ...event })
    await app.settle()
    assert.equal(app.cell.cell.outputs.length, 1)
    assert.equal(app.cell.cell.outputs[0].text, 'FRESH')
    assert.equal(app.cell.cell.execution_count, 1)
    assert.equal(app.toolbar.dirty, false)
    assert.equal(app.banner, null)
    assert.equal(JSON.stringify(app.toolbar.kernel), kernelAfterReload)
  }
  stream.end()
  await app.settle()
  assert.equal(app.cell.cell.outputs[0].text, 'FRESH')
})

for (const termination of ['fatal', 'stream-error', 'fetch-error']) {
  test(`reload preserves new outputs when the old run ends with ${termination} without a reply`, async (t) => {
    const app = mountNotebook(t)
    await app.settle()
    const request = app.run()
    const stream = executionStream()
    if (termination !== 'fetch-error') { request.resolve(stream.response); await app.settle() }
    app.reload()
    if (termination === 'fetch-error') request.reject(new Error('STALE FETCH ERROR'))
    else if (termination === 'stream-error') stream.fail(new Error('STALE STREAM ERROR'))
    else { stream.emit({ type: 'fatal', message: 'STALE FATAL' }); stream.end() }
    await app.settle()
    assert.equal(app.cell.cell.outputs[0].text, 'FRESH')
    assert.equal(app.cell.cell.execution_count, 1)
    assert.equal(app.toolbar.dirty, false)
    assert.equal(app.banner, null)
    assert.equal(app.toolbar.running, false)
  })
}

test('cancelling the host reload prompt keeps the current execution alive', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  const request = app.run()
  const stream = executionStream()
  request.resolve(stream.response)
  await app.settle()
  app.cancelReload()
  assert.equal(request.init.signal.aborted, false)
  stream.emit({ type: 'stream', cell_id: 'cell-1', text: 'RESULT' })
  stream.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: true, execution_count: 2 })
  stream.end()
  await app.settle()
  assert.equal(app.cell.cell.outputs[0].text, 'RESULT')
  assert.equal(app.cell.cell.execution_count, 2)
  assert.equal(app.toolbar.dirty, true)
})

for (const outcome of ['conflict', 'failure', 'success']) {
  test(`late save ${outcome} cannot change a reloaded document or unlock its active save`, async (t) => {
    const app = mountNotebook(t)
    await app.settle()
    app.edit('old draft')
    const oldSave = app.save()
    app.reload()
    app.edit('fresh draft')
    const newSave = app.save()
    assert.equal(app.requests('save').length, 2, 'a superseded request cannot block saving the adopted document')
    assert.equal(newSave.body.baseVersion, 'v2')
    assert.equal(newSave.body.notebook.cells[0].outputs[0].text, 'FRESH')
    if (outcome === 'conflict') oldSave.resolve(response({ ok: false, error: { code: 'write-conflict', message: 'STALE', details: { version: 'v2' } } }, 409))
    else if (outcome === 'failure') oldSave.reject(new Error('STALE NETWORK FAILURE'))
    else oldSave.resolve(response({ ok: true, value: { version: 'STALE VERSION' } }))
    await app.settle()
    assert.equal(app.cell.cell.source, 'fresh draft')
    assert.equal(app.cell.cell.outputs[0].text, 'FRESH')
    assert.equal(app.toolbar.dirty, true)
    assert.equal(app.toolbar.conflict, null)
    assert.equal(app.banner, null)
    assert.equal(app.toolbar.saveState, 'saving')
    app.save()
    app.cell.onSave()
    await app.settle()
    assert.equal(app.requests('save').length, 2, 'the stale finally must not release the newer save lock')
    newSave.resolve(response({ ok: true, value: { version: 'v3' } }))
    await app.settle()
    assert.equal(app.toolbar.dirty, false)
    assert.equal(app.toolbar.saveState, 'saved')
    app.edit('next draft')
    const nextSave = app.save()
    assert.equal(nextSave.body.baseVersion, 'v3', 'the accepted save, not the stale response, owns the version')
    nextSave.resolve(response({ ok: true, value: { version: 'v4' } }))
    await app.settle()
  })
}

test('successful execution remains editable and its completed outputs can be saved', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.edit('print("RESULT")')
  const request = app.run()
  const stream = executionStream()
  request.resolve(stream.response)
  await app.settle()
  stream.emit({ type: 'stream', cell_id: 'cell-1', name: 'stdout', text: 'RESULT' })
  stream.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: true, execution_count: 2 })
  stream.end()
  await app.settle()
  assert.equal(app.toolbar.running, false)
  assert.equal(app.toolbar.dirty, true)
  const save = app.save()
  assert.equal(save.body.notebook.cells[0].outputs[0].text, 'RESULT')
  assert.equal(save.body.notebook.cells[0].execution_count, 2)
  save.resolve(response({ ok: true, value: { version: 'v2' } }))
  await app.settle()
  assert.equal(app.toolbar.dirty, false)
  assert.equal(app.toolbar.saveState, 'saved')
})

test('an older save completion cannot clear execution results committed in the same render batch', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.edit()
  const oldSave = app.save()
  const request = app.runWithoutCommit()
  const stream = executionStream()
  request.resolve(stream.response)
  stream.emit({ type: 'stream', cell_id: 'cell-1', text: 'NEW RESULT' })
  stream.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: true, execution_count: 2 })
  stream.end()
  // No React commit occurs between execution updates and the old save reply.
  // Refs synchronized only during render still point to the old save snapshot.
  await settleWithoutCommit()
  oldSave.resolve(response({ ok: true, value: { version: 'v2' } }))
  await settleWithoutCommit()
  app.flush()
  assert.equal(app.cell.cell.outputs[0].text, 'NEW RESULT')
  assert.equal(app.toolbar.dirty, true, 'newly produced results have not been persisted by the older save')
  const resultSave = app.save()
  assert.equal(app.requests('save').length, 2)
  assert.equal(resultSave.body.baseVersion, 'v2')
  assert.equal(resultSave.body.notebook.cells[0].outputs[0].text, 'NEW RESULT')
  resultSave.resolve(response({ ok: true, value: { version: 'v3' } }))
  await app.settle()
  assert.equal(app.toolbar.dirty, false)
})

test('an old execution finalizer cannot clear the newer execution or allow overlapping runs', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  const oldRequest = app.run()
  const oldStream = executionStream()
  oldRequest.resolve(oldStream.response)
  await app.settle()
  app.reload()
  const newRequest = app.run()
  assert.equal(app.requests('execute').length, 2, 'the adopted notebook can start a new execution')
  const newStream = executionStream()
  newRequest.resolve(newStream.response)
  await app.settle()
  newStream.emit({ type: 'stream', cell_id: 'cell-1', text: 'NEW RUN' })
  await app.settle()
  oldStream.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: true, execution_count: 99 })
  oldStream.end()
  await app.settle()
  assert.equal(app.toolbar.running, true)
  assert.equal(app.cell.cell.outputs[0].text, 'NEW RUN')
  assert.equal(app.cell.cell.execution_count, null)
  app.run()
  assert.equal(app.requests('execute').length, 2, 'the newer execution still owns the running lock')
  newStream.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: true, execution_count: 2 })
  newStream.end()
  await app.settle()
  assert.equal(app.toolbar.running, false)
  assert.equal(app.cell.cell.execution_count, 2)
})

test('an old Run all finalizer cannot stop or duplicate the newly adopted batch', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  const twoCells = notebookData()
  twoCells.notebook.cells.push({ ...twoCells.notebook.cells[0], id: 'cell-2', source: 'print("second")' })
  app.reload(twoCells)
  const oldBatch = app.toolbar.onRunAll()
  app.flush()
  const oldStream = executionStream()
  app.requests('execute')[0].resolve(oldStream.response)
  await app.settle()
  app.reload({ ...twoCells, version: 'v2' })
  const newBatch = app.toolbar.onRunAll()
  app.flush()
  assert.equal(app.requests('execute').length, 2)
  const newStream = executionStream()
  app.requests('execute')[1].resolve(newStream.response)
  await app.settle()
  oldStream.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: true, execution_count: 99 })
  oldStream.end()
  await app.settle()
  await oldBatch
  assert.equal(app.toolbar.runAllRunning, true, 'the new batch still owns Run all state')
  assert.equal(app.requests('execute').length, 2, 'the old batch must not advance into another cell')
  newStream.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: true, execution_count: 2 })
  newStream.end()
  await app.settle()
  assert.equal(app.requests('execute').length, 3)
  assert.equal(app.requests('execute')[2].body.cellId, 'cell-2')
  const secondStream = executionStream()
  app.requests('execute')[2].resolve(secondStream.response)
  secondStream.emit({ type: 'execute_reply', cell_id: 'cell-2', ok: true, execution_count: 3 })
  secondStream.end()
  await app.settle()
  await newBatch
  assert.equal(app.toolbar.runAllRunning, false)
})

const OUTPUT_CAP_BYTES = 32 * 1024 * 1024
const MiB = 1024 * 1024
const outputBytes = (outputs) => Buffer.byteLength(JSON.stringify(outputs), 'utf8')

async function startOutputRun(app) {
  await app.settle()
  const request = app.run()
  assert.ok(request)
  const stream = executionStream()
  request.resolve(stream.response)
  await app.settle()
  return {
    emit(event) { stream.emit({ cell_id: 'cell-1', ...event }) },
    async send(event) { stream.emit({ cell_id: 'cell-1', ...event }); await app.settle() },
    async finish() {
      stream.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: true, execution_count: 2 })
      stream.end()
      await app.settle()
    },
    end() { stream.end() },
  }
}

function assertOutputLimit(app) {
  const outputs = app.cell.cell.outputs
  assert.equal(outputs.length, 1, 'an exceeded budget leaves one bounded marker')
  assert.equal(outputs[0].output_type, 'stream')
  assert.equal(outputs[0].name, 'stderr')
  assert.match(outputs[0].text, /limit|truncat/i)
  assert.ok(outputBytes(outputs) < 1024, 'the marker itself must stay bounded')
  assert.equal(app.banner?.kind, 'info')
  return JSON.stringify(outputs)
}

test('the output budget counts UTF-8 Chinese and emoji bytes', async (t) => {
  const app = mountNotebook(t)
  const run = await startOutputRun(app)
  // 15 Mi UTF-16 units, but 35 MiB in UTF-8, before JSON structure.
  await run.send({ type: 'display_data', data: { 'text/plain': '汉😀'.repeat(5 * MiB) }, metadata: {} })
  assertOutputLimit(app)
  await run.finish()
})

for (const field of ['error', 'metadata']) {
  test(`the output budget includes ${field} content outside MIME data`, async (t) => {
    const app = mountNotebook(t)
    const run = await startOutputRun(app)
    const event = field === 'error'
      ? { type: 'error', ename: 'Error', evalue: 'e'.repeat(2 * MiB), traceback: ['x'.repeat(31 * MiB)] }
      : { type: 'display_data', data: { 'text/plain': 'x' }, metadata: { extra: 'x'.repeat(33 * MiB) } }
    await run.send(event)
    assertOutputLimit(app)
    await run.finish()
  })
}

test('the exact serialized output boundary is accepted, stream merging obeys it, and clearing or rerunning resets it', async (t) => {
  const app = mountNotebook(t)
  const run = await startOutputRun(app)
  const overhead = outputBytes([{ output_type: 'stream', name: 'stdout', text: '' }])
  const text = 'x'.repeat(OUTPUT_CAP_BYTES - overhead)
  await run.send({ type: 'stream', name: 'stdout', text })
  assert.equal(outputBytes(app.cell.cell.outputs), OUTPUT_CAP_BYTES, 'the complete JSON output array defines the boundary')
  assert.equal(app.cell.cell.outputs[0].text.length, text.length)
  assert.equal(app.banner, null)
  await run.send({ type: 'stream', name: 'stdout', text: 'x' })
  const marker = assertOutputLimit(app)
  for (const event of [
    { type: 'stream', name: 'stderr', text: 'AFTER LIMIT' },
    { type: 'error', ename: 'LateError', evalue: 'late', traceback: ['late'] },
    { type: 'display_data', display_id: 'late', data: { 'text/plain': 'late' }, metadata: {} },
    { type: 'update_display_data', display_id: 'late', data: { 'text/plain': 'later' }, metadata: {} },
  ]) await run.send(event)
  assert.equal(JSON.stringify(app.cell.cell.outputs), marker, 'all later output kinds remain dropped in this run')
  await run.send({ type: 'clear_output', wait: false })
  assert.equal(app.cell.cell.outputs.length, 0)
  await run.send({ type: 'stream', name: 'stdout', text: 'AFTER CLEAR' })
  assert.equal(app.cell.cell.outputs[0].text, 'AFTER CLEAR')
  // Re-enter the truncated state so rerun must reset an active limit flag,
  // rather than merely inheriting the already-cleared budget.
  await run.send({ type: 'display_data', data: { 'text/plain': text }, metadata: {} })
  assertOutputLimit(app)
  await run.finish()
  const rerun = await startOutputRun(app)
  await rerun.send({ type: 'stream', name: 'stdout', text: 'NEW RUN' })
  assert.equal(app.cell.cell.outputs.length, 1)
  assert.equal(app.cell.cell.outputs[0].text, 'NEW RUN')
  await rerun.finish()
})

test('display updates charge every matching display id and cannot escape a truncated cell', async (t) => {
  const app = mountNotebook(t)
  const run = await startOutputRun(app)
  for (let index = 0; index < 2; index += 1) {
    await run.send({ type: 'display_data', display_id: 'shared', data: { 'text/plain': 'small' }, metadata: {} })
  }
  await run.send({ type: 'update_display_data', display_id: 'shared', data: { 'text/plain': 'x'.repeat(17 * MiB) }, metadata: {} })
  const marker = assertOutputLimit(app)
  await run.send({ type: 'update_display_data', display_id: 'shared', data: { 'text/plain': 'small again' }, metadata: {} })
  await run.send({ type: 'display_data', display_id: 'shared', data: { 'text/plain': 'new display' }, metadata: {} })
  assert.equal(JSON.stringify(app.cell.cell.outputs), marker)
  await run.finish()
})

test('shrinking a display releases its old data and metadata budget; unmatched updates do not consume it', async (t) => {
  const app = mountNotebook(t)
  const run = await startOutputRun(app)
  await run.send({ type: 'display_data', display_id: 'plot', data: { 'text/plain': 'x'.repeat(2 * MiB) }, metadata: { extra: 'm'.repeat(16 * MiB) } })
  await run.send({ type: 'update_display_data', display_id: 'plot', data: { 'text/plain': 'small' }, metadata: {} })
  await run.send({ type: 'update_display_data', display_id: 'missing', data: { 'text/plain': 'x'.repeat(33 * MiB) }, metadata: {} })
  await run.send({ type: 'display_data', data: { 'text/plain': 'x'.repeat(31 * MiB) }, metadata: {} })
  const outputs = app.cell.cell.outputs
  assert.equal(outputs.length, 2)
  assert.equal(outputs[0].data['text/plain'], 'small')
  assert.equal(Object.keys(outputs[0].metadata).length, 0)
  assert.equal(outputs[1].data['text/plain'].length, 31 * MiB)
  assert.ok(outputBytes(outputs) < OUTPUT_CAP_BYTES)
  assert.equal(app.banner, null)
  await run.finish()
})

test('deferred clearing follows event order even before React commits and includes display updates', async (t) => {
  const app = mountNotebook(t)
  const run = await startOutputRun(app)
  await run.send({ type: 'stream', name: 'stdout', text: 'INITIAL' })
  run.emit({ type: 'stream', name: 'stdout', text: 'BEFORE CLEAR' })
  run.emit({ type: 'clear_output', wait: true })
  run.emit({ type: 'stream', name: 'stdout', text: 'AFTER CLEAR' })
  await settleWithoutCommit()
  app.flush()
  assert.equal(app.cell.cell.outputs.length, 1)
  assert.equal(app.cell.cell.outputs[0].text, 'AFTER CLEAR', 'an earlier queued output must not consume a later deferred clear')

  await run.send({ type: 'clear_output', wait: false })
  await run.send({ type: 'display_data', display_id: 'plot', data: { 'text/plain': 'OLD PLOT' }, metadata: {} })
  await run.send({ type: 'clear_output', wait: true })
  await run.send({ type: 'status', execution_state: 'busy' })
  assert.equal(app.cell.cell.outputs[0].data['text/plain'], 'OLD PLOT', 'a status event does not consume deferred clear')
  await run.send({ type: 'update_display_data', display_id: 'plot', data: { 'text/plain': 'UPDATE' }, metadata: {} })
  assert.equal(app.cell.cell.outputs.length, 0, 'the update consumes clear before looking for display ids to replace')
  await run.send({ type: 'stream', name: 'stdout', text: 'FRESH' })
  assert.equal(app.cell.cell.outputs[0].text, 'FRESH')
  await run.finish()
})

test('queued overflow, immediate clear and fresh output remain ordered when the run finishes before a React commit', async (t) => {
  const app = mountNotebook(t)
  const run = await startOutputRun(app)
  run.emit({ type: 'display_data', data: { 'text/plain': 'x'.repeat(33 * MiB) }, metadata: {} })
  run.emit({ type: 'clear_output', wait: false })
  run.emit({ type: 'stream', name: 'stdout', text: 'FRESH AFTER LIMIT' })
  run.emit({ type: 'execute_reply', ok: true, execution_count: 2 })
  run.end()
  await settleWithoutCommit()
  app.flush()
  assert.equal(app.cell.cell.outputs.length, 1)
  assert.equal(app.cell.cell.outputs[0].text, 'FRESH AFTER LIMIT')
  assert.equal(app.toolbar.running, false)
  assert.equal(app.toolbar.dirty, true)
})

test('a deferred clear resets a truncated cell on its next display update, and reload discards old budget state', async (t) => {
  const app = mountNotebook(t)
  const run = await startOutputRun(app)
  const oversized = { type: 'display_data', data: { 'text/plain': 'x'.repeat(33 * MiB) }, metadata: {} }
  await run.send(oversized)
  const marker = assertOutputLimit(app)
  await run.send({ type: 'clear_output', wait: true })
  await run.send({ type: 'ping' })
  assert.equal(JSON.stringify(app.cell.cell.outputs), marker)
  await run.send({ type: 'update_display_data', display_id: 'missing', data: { 'text/plain': 'unused' }, metadata: {} })
  assert.equal(app.cell.cell.outputs.length, 0)
  await run.send({ type: 'stream', name: 'stdout', text: 'AFTER DEFERRED CLEAR' })
  assert.equal(app.cell.cell.outputs[0].text, 'AFTER DEFERRED CLEAR')
  await run.send(oversized)
  assertOutputLimit(app)
  app.reload()
  const fresh = await startOutputRun(app)
  run.emit({ type: 'clear_output', wait: true })
  run.emit({ type: 'update_display_data', display_id: 'missing', data: { 'text/plain': 'STALE' }, metadata: {} })
  run.end()
  await fresh.send({ type: 'stream', name: 'stdout', text: 'NEW DOCUMENT' })
  assert.equal(app.cell.cell.outputs.length, 1)
  assert.equal(app.cell.cell.outputs[0].text, 'NEW DOCUMENT')
  assert.equal(app.banner, null)
  await fresh.finish()
})

test('truncating one cell in Run all does not consume the next cell budget', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  const data = notebookData()
  data.notebook.cells.push({ ...data.notebook.cells[0], id: 'cell-2', outputs: [] })
  app.reload(data)
  const batch = app.toolbar.onRunAll()
  app.flush()
  const first = executionStream()
  app.requests('execute')[0].resolve(first.response)
  await app.settle()
  first.emit({ type: 'display_data', cell_id: 'cell-1', data: { 'text/plain': 'x'.repeat(33 * MiB) }, metadata: {} })
  await app.settle()
  assertOutputLimit(app)
  first.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: true, execution_count: 1 })
  first.end()
  await app.settle()
  assert.equal(app.requests('execute').length, 2)
  const second = executionStream()
  app.requests('execute')[1].resolve(second.response)
  second.emit({ type: 'stream', cell_id: 'cell-2', name: 'stdout', text: 'SECOND CELL' })
  second.emit({ type: 'execute_reply', cell_id: 'cell-2', ok: true, execution_count: 2 })
  second.end()
  await app.settle()
  await batch
  const save = app.save()
  assert.equal(save.body.notebook.cells[1].outputs.length, 1)
  assert.equal(save.body.notebook.cells[1].outputs[0].text, 'SECOND CELL')
  save.resolve(response({ ok: true, value: { version: 'v2' } }))
  await app.settle()
})
