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

function nestedMetadata(depth) {
  let metadata = {}
  for (let index = 0; index < depth; index += 1) metadata = { child: metadata }
  return metadata
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
function mountNotebook(t, options = {}) {
  const slots = []
  const timers = new Map()
  const requests = []
  // window.addEventListener stub: the viewer installs one keydown listener for
  // its lifetime; tests dispatch synthetic events through this set.
  const windowListeners = new Map()
  let cursor = 0, nextTimer = 0, needsRender = true, mounted = true
  let pendingEffects = [], pendingState = [], tree, moduleOptions, moduleExports, hostReloads = 0
  // Optional Host locale face: when requested, apply() binds the plugin's
  // namespace dictionaries and the viewer subscribes through
  // useSyncExternalStore, so a locale switch re-renders the same mounted tree.
  const localeState = { active: 'en', revision: 1 }
  const localeListeners = new Set()
  const localeFace = options.locale
    ? {
        register() {
          return () => {}
        },
        bind() {
          return (key) => moduleExports.__test.STRINGS[localeState.active][key] ?? moduleExports.__test.STRINGS.en[key] ?? key
        },
        subscribe(listener) {
          localeListeners.add(listener)
          return () => localeListeners.delete(listener)
        },
        getSnapshot() {
          return { active: localeState.active, revision: localeState.revision, locales: [] }
        },
      }
    : undefined
  let props = {
    ctx: {
      betterSidebar: { hostRouteUrl: (route) => 'http://host/' + route },
      ...(localeFace ? { get: (name) => (name === 'locale' ? localeFace : undefined) } : {}),
    },
    scope: { sessionId: 'session-1' }, path: '/workspace/demo.ipynb',
    visible: options.visible === undefined ? false : options.visible,
    customData: options.customData || notebookData(), onReload() { hostReloads += 1 },
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
    useSyncExternalStore(subscribe, getSnapshot) {
      const index = cursor++
      const previous = slots[index]
      if (previous && previous.subscribe === subscribe) {
        previous.getSnapshot = getSnapshot
      } else {
        previous?.unsubscribe?.()
        slots[index] = {
          subscribe,
          getSnapshot,
          unsubscribe: subscribe(() => {
            needsRender = true
          }),
        }
      }
      return slots[index].getSnapshot()
    },
  }
  const fetch = (url, init = {}) => {
    const route = new URL(url).pathname.split('/').pop()
    if (route === 'interpreters') return Promise.resolve(response({ ok: true, value: { interpreters: [{ ok: true, path: '/python' }], default: '/python' } }))
    if (route === 'status' && !options.deferStatus) {
      return Promise.resolve(response({ ok: true, value: { running: false, ready: false, busy: false, python: null, executionState: 'none' } }))
    }
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
      addEventListener(type, listener) {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set())
        windowListeners.get(type).add(listener)
      },
      removeEventListener(type, listener) {
        windowListeners.get(type)?.delete(listener)
      },
    },
    navigator: { language: 'en-US' },
    URLSearchParams, TextDecoder, TextEncoder, AbortController, fetch,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    setInterval(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearInterval(id) { timers.delete(id) },
  })
  vm.runInContext(clientSource, context, { filename: 'client.js' })
  moduleExports = moduleOptions.factory(() => react)
  const { NotebookView } = moduleExports.__test
  if (localeFace) {
    moduleExports.apply({
      effect: (effect) => effect(),
      inject: (names, callback) => callback({ locale: localeFace, effect: (effect) => effect() }),
      betterSidebar: { registerFileViewer: () => () => {}, hostRouteUrl: (route) => 'http://host/' + route },
    })
  }
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
  const components = (name) => {
    flush()
    const found = []
    const pending = [tree]
    while (pending.length) {
      const element = pending.shift()
      if (!element || typeof element !== 'object') continue
      if (Array.isArray(element)) { pending.push(...element); continue }
      if (element.type?.name === name) found.push(element)
      pending.push(...(element.props?.children || []))
    }
    return found
  }
  const find = (predicate) => {
    flush()
    return findElement(tree, predicate)
  }
  const api = {
    flush, settle, component, components, find,
    timersFor: (delay) => [...timers.values()].filter((timer) => timer.delay === delay),
    fireTimer(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay)
      assert.ok(entry, 'timer is armed for ' + delay + 'ms')
      timers.delete(entry[0])
      entry[1].callback()
      flush()
    },
    get toolbar() { return component('Toolbar').props },
    get cell() { return component('CellView').props },
    get banner() { return component('Banner').props.banner },
    get bannerText() {
      const banner = component('Banner')
      const text = findElement(banner.type(banner.props), (value) => value.props?.className === 'dsh-bsb-ipynb-banner-text')
      return text && text.props.children[0]
    },
    get reloadCount() { return hostReloads },
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
    setVisible(value) {
      props = { ...props, visible: value }
      needsRender = true
      flush()
    },
    dispatchKey(event = {}) {
      if (typeof event.preventDefault !== 'function') {
        event.defaultPrevented = Boolean(event.defaultPrevented)
        event.preventDefault = function preventDefault() {
          this.defaultPrevented = true
        }
      }
      for (const listener of [...(windowListeners.get('keydown') || [])]) listener(event)
      return event
    },
    get keyListenerCount() {
      return (windowListeners.get('keydown') || new Set()).size
    },
    unmount() {
      mounted = false
      for (const slot of slots) {
        slot?.cleanup?.()
        slot.cleanup = null
        slot?.unsubscribe?.()
        slot.unsubscribe = null
      }
    },
    setLocale(active) {
      localeState.active = active
      localeState.revision += 1
      for (const listener of [...localeListeners]) listener()
      flush()
    },
    get localeListenerCount() {
      return localeListeners.size
    },
  }
  t.after(() => {
    mounted = false
    for (const slot of slots) {
      slot?.cleanup?.()
      slot?.unsubscribe?.()
    }
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

test('a save completion preserves a kernel death reported while it was in flight', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.edit()
  const save = app.save()
  const execution = app.run()
  const stream = executionStream()
  execution.resolve(stream.response)
  await app.settle()
  stream.emit({ type: 'kernel_died', message: 'kernel crashed' })
  await app.settle()
  assert.equal(app.banner?.kind, 'error')
  assert.equal(app.bannerText, 'kernel crashed')

  save.resolve(response({ ok: true, value: { version: 'v2' } }))
  await app.settle()
  assert.equal(app.toolbar.saveState, 'saved')
  assert.equal(app.bannerText, 'kernel crashed', 'the older save must not erase the newer kernel error')
  stream.end()
  await app.settle()
  assert.equal(app.bannerText, 'kernel crashed')
})

test('write-blocked saves retry unchanged snapshots with backoff and stop after success', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.edit()
  let request = app.save()
  const originalSnapshot = JSON.stringify(request.body.notebook)
  for (const [index, delay] of [6000, 24000, 30000].entries()) {
    request.resolve(response({ ok: false, error: { code: 'write-blocked', message: 'locked', details: { reason: 'locked' } } }, 409))
    await app.settle()
    assert.equal(app.toolbar.dirty, true)
    assert.equal(app.banner?.reason, 'write-blocked')
    assert.equal(app.timersFor(delay).length, 1, 'the unchanged snapshot retries after ' + delay + 'ms')
    app.fireTimer(delay)
    await app.settle()
    request = app.requests('save').at(-1)
    assert.equal(app.requests('save').length, index + 2)
    assert.equal(JSON.stringify(request.body.notebook), originalSnapshot)
  }

  request.resolve(response({ ok: true, value: { version: 'v2', size: 42 } }))
  await app.settle()
  assert.equal(app.toolbar.dirty, false)
  assert.equal(app.banner, null, 'success clears the write-blocked banner')
  for (const delay of [1500, 6000, 24000, 30000]) {
    assert.equal(app.timersFor(delay).length, 0, 'a clean notebook leaves no retry armed')
  }
})

test('ordinary save failures wait for an edit and clear their banner after the next success', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.edit()
  const failed = app.save()
  failed.resolve(response({ ok: false, error: { message: 'disk error' } }, 500))
  await app.settle()
  assert.equal(app.toolbar.dirty, true)
  assert.equal(app.toolbar.saveState, 'failed')
  assert.equal(app.banner?.reason, 'save-failed')
  for (const delay of [1500, 6000, 24000, 30000]) {
    assert.equal(app.timersFor(delay).length, 0, 'an unchanged ordinary failure must not retry')
  }

  app.edit('print("retry")')
  assert.equal(app.timersFor(1500).length, 1, 'a new edit re-arms normal autosave')
  app.fireTimer(1500)
  await app.settle()
  const retry = app.requests('save').at(-1)
  assert.equal(app.requests('save').length, 2)
  retry.resolve(response({ ok: true, value: { version: 'v2', size: 42 } }))
  await app.settle()
  assert.equal(app.toolbar.dirty, false)
  assert.equal(app.banner, null, 'success clears the old generic save failure')
})

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

test('clearing a cell output empties it and marks the notebook dirty', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  assert.equal(app.cell.cell.outputs.length, 1)
  app.cell.onClearOutputs('cell-1')
  await app.settle()
  assert.equal(app.cell.cell.outputs.length, 0)
  assert.equal(app.cell.cell.execution_count, 1, 'clearing output leaves the execution count alone')
  assert.equal(app.toolbar.dirty, true)
})

test('an oversized notebook retranslates its dynamic banner and can be saved after clearing outputs', async (t) => {
  const app = mountNotebook(t, { locale: true })
  await app.settle()
  assert.ok(app.localeListenerCount > 0, 'the viewer subscribes to the Host locale face')
  const saveTitle = () => {
    const toolbar = app.component('Toolbar')
    const button = findElement(
      toolbar.type(toolbar.props),
      (value) => value.props?.title === 'Save' || value.props?.title === '保存',
    )
    return button && button.props.title
  }
  assert.equal(saveTitle(), 'Save', 'the mounted toolbar starts in the Host English locale')
  // Load a document whose pretty nbformat form exceeds the server's 32 MiB cap.
  app.reload(notebookData('x'.repeat(33 * MiB), 'v2'))
  await app.settle()
  app.edit('print("edited")')
  app.save()
  await app.settle()
  assert.equal(app.requests('save').length, 0, 'an oversized notebook must not be uploaded')
  assert.equal(app.banner?.kind, 'error')
  assert.equal(app.banner.key, 'capacityTooLarge')
  assert.equal(Object.hasOwn(app.banner, 'text'), false, 'the translated capacity message is not frozen into state')
  const size = app.banner.params.size
  const english = app.bannerText
  assert.match(english, /32 MiB/)
  assert.match(english, new RegExp(size))
  app.setLocale('zh')
  assert.equal(app.banner.params.size, size, 'the measured size survives a locale switch')
  assert.match(app.bannerText, /notebook 内容约/)
  assert.match(app.bannerText, new RegExp(size.replace('.', '\\.')))
  assert.equal(saveTitle(), '保存', 'the mounted toolbar follows the Host locale switch')
  app.setLocale('en')
  assert.equal(app.bannerText, english, 'switching back reproduces the original interpolated English text')
  assert.equal(saveTitle(), 'Save', 'switching back restores the English save title')
  assert.equal(app.saveButton().disabled, false, 'manual save stays available for the retry')
  assert.equal(app.timersFor(1500).length, 0, 'a capacity block must not leave an autosave retry armed')
  app.edit('print("edited again")')
  await app.settle()
  assert.equal(app.timersFor(1500).length, 0, 'further edits must not re-arm autosave while blocked')

  // The banner action clears every output, which releases the block.
  const banner = app.component('Banner')
  const clearAll = findElement(banner.type(banner.props), (value) => value.props?.title === 'Clear all outputs')
  assert.ok(clearAll, 'the capacity banner offers a clear-all-outputs action')
  clearAll.props.onClick()
  await app.settle()
  assert.equal(app.cell.cell.outputs.length, 0)
  assert.equal(app.banner, null, 'clearing outputs dismisses the capacity banner')
  assert.equal(app.toolbar.dirty, true)

  const request = app.save()
  assert.ok(request, 'the cleared notebook is uploaded again')
  request.resolve(response({ ok: true, value: { version: 'v3', size: 64 } }))
  await app.settle()
  assert.equal(request.body.notebook.cells[0].outputs.length, 0)
  assert.equal(app.toolbar.dirty, false)
})

test('an oversized notebook without outputs does not offer a no-op clear action', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  const data = notebookData('', 'v2')
  data.notebook.cells[0].outputs = []
  data.notebook.cells[0].source = 'x'.repeat(33 * MiB)
  app.reload(data)
  await app.settle()
  app.edit(data.notebook.cells[0].source)
  app.save()
  await app.settle()
  assert.equal(app.requests('save').length, 0, 'the oversized source-only notebook must not be uploaded')
  assert.equal(app.banner?.kind, 'error')
  assert.equal(app.banner.action, undefined, 'there is nothing to clear, so no clear action is offered')
  assert.match(app.bannerText, /32 MiB/)
  assert.match(app.bannerText, /no outputs to clear/i)
  const banner = app.component('Banner')
  const clearAll = findElement(banner.type(banner.props), (value) => value.props?.title === 'Clear all outputs')
  assert.equal(clearAll, null, 'no clear-all button is rendered when there are no outputs')
  assert.equal(app.saveButton().disabled, false, 'manual save stays available for the retry')
})

test('metadata preflight offers the matching recovery for output, notebook and cell metadata', async (t) => {
  for (const location of ['output', 'notebook', 'cell']) {
    const scenario = `${location} metadata`
    const app = mountNotebook(t)
    await app.settle()
    const data = notebookData('OLD', 'v2')
    if (location === 'output') {
      data.notebook.cells[0].outputs = [{
        output_type: 'display_data',
        data: { 'text/plain': 'result' },
        metadata: nestedMetadata(101),
      }]
    } else if (location === 'notebook') {
      data.notebook.metadata = nestedMetadata(101)
    } else {
      data.notebook.cells[0].metadata = nestedMetadata(101)
    }
    app.reload(data)
    await app.settle()
    app.edit('print("edited")')
    app.save()
    await app.settle()
    assert.equal(app.requests('save').length, 0, `${scenario}: over-complex metadata is blocked before upload`)
    assert.equal(app.banner?.reason, 'metadata-too-complex', `${scenario}: the preflight failure is stored in banner state`)

    if (location === 'output') {
      assert.equal(app.banner.key, 'metadataTooComplex', `${scenario}: the banner stores a translatable key`)
      assert.equal(app.banner.action, 'clear-outputs', `${scenario}: the clear-outputs action is offered`)
      const banner = app.component('Banner')
      const clearAll = findElement(banner.type(banner.props), (value) => value.props?.title === 'Clear all outputs')
      assert.ok(clearAll, `${scenario}: output metadata problems reuse the confirmed clear-all action`)
      clearAll.props.onClick()
      await app.settle()
      assert.equal(app.cell.cell.outputs.length, 0, `${scenario}: the clear action empties the outputs`)
      assert.equal(app.banner, null, `${scenario}: clearing outputs dismisses the banner`)
      assert.equal(app.toolbar.dirty, true, `${scenario}: the cleared notebook stays dirty`)

      const retry = app.save()
      assert.ok(retry, `${scenario}: clearing the offending outputs releases the preflight block`)
      assert.equal(retry.body.notebook.cells[0].outputs.length, 0, `${scenario}: the retry uploads no outputs`)
      retry.resolve(response({ ok: true, value: { version: 'v3', size: 64 } }))
      await app.settle()
      assert.equal(app.toolbar.dirty, false, `${scenario}: the retry save succeeds`)
      assert.equal(app.toolbar.saveState, 'saved', `${scenario}: the save state settles after the retry`)
    } else {
      assert.equal(app.banner.action, 'reload', `${scenario}: reload replaces the ineffective clear action`)
      const banner = app.component('Banner')
      const rendered = banner.type(banner.props)
      const reload = findElement(rendered, (value) => value.props?.title === 'Reload')
      const clearAll = findElement(rendered, (value) => value.props?.title === 'Clear all outputs')
      assert.ok(reload, `${scenario}: the banner provides the host reload action`)
      assert.equal(clearAll, null, `${scenario}: clearing outputs cannot repair notebook or cell metadata`)
      const reloadCount = app.reloadCount
      reload.props.onClick()
      assert.equal(app.reloadCount, reloadCount + 1, `${scenario}: the action delegates to the existing host reload flow`)
    }
  }
})

test('rendered outputs, toolbar state and banners expose accessible semantics', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  const cell = app.component('CellView')
  const cellTree = cell.type(cell.props)
  const outputs = findElement(cellTree, (value) => value.props?.className === 'dsh-bsb-ipynb-outputs')
  assert.equal(outputs.props.role, 'log')
  assert.equal(outputs.props['aria-live'], 'polite')
  const output = findElement(cellTree, (value) => value.type?.name === 'OutputView')
  const rendered = output.type(output.props)
  assert.equal(rendered.props.tabIndex, 0, 'scrollable output text is keyboard focusable')

  const toolbar = app.component('Toolbar')
  const toolbarTree = toolbar.type(toolbar.props)
  const kernelLabel = findElement(toolbarTree, (value) => String(value.props?.className || '').includes('dsh-bsb-ipynb-kernel-label'))
  assert.equal(kernelLabel.props['aria-live'], 'polite')
  const pythonSelect = findElement(toolbarTree, (value) => value.type === 'select' && String(value.props?.className || '').includes('python-select'))
  assert.equal(pythonSelect.props['aria-label'], 'Python')

  app.edit()
  const request = app.save()
  request.resolve(response({ ok: false, error: { code: 'write-conflict', message: 'STALE', details: { version: 'v2' } } }, 409))
  await app.settle()
  const banner = app.component('Banner')
  const box = findElement(banner.type(banner.props), (value) => String(value.props?.className || '').includes('dsh-bsb-ipynb-banner'))
  assert.equal(box.props.role, 'alert', 'error banners are announced as alerts')
})

test('a running cell disables Run on every cell', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  const twoCells = notebookData()
  twoCells.notebook.cells.push({ ...twoCells.notebook.cells[0], id: 'cell-2', source: 'print("second")' })
  app.reload(twoCells)
  await app.settle()
  const request = app.run()
  const stream = executionStream()
  request.resolve(stream.response)
  await app.settle()
  const cells = app.components('CellView')
  assert.equal(cells.length, 2)
  for (const element of cells) {
    const runButton = findElement(element.type(element.props), (value) => value.props?.title === 'Run cell')
    assert.ok(runButton, 'each code cell renders a Run button')
    assert.equal(runButton.props.disabled, true, 'a global execution blocks Run on every cell')
  }
  stream.end()
  await app.settle()
})

test('a hidden notebook keeps a stopped kernel off through execution preflight failure', async (t) => {
  const app = mountNotebook(t, { locale: true })
  const off = { running: false, ready: false, busy: false, executionState: 'none' }
  const kernelState = () => {
    const { running, ready, busy, executionState } = app.toolbar.kernel
    return { running, ready, busy, executionState }
  }
  const toolbarState = () => {
    const toolbar = app.component('Toolbar')
    const rendered = toolbar.type(toolbar.props)
    const label = findElement(rendered, (value) => String(value.props?.className || '').includes('dsh-bsb-ipynb-kernel-label'))
    const dot = findElement(rendered, (value) => String(value.props?.className || '').includes('dsh-bsb-ipynb-kernel-dot'))
    assert.ok(label)
    assert.ok(dot)
    return { state: label.props.children[0], dot: dot.props.className }
  }

  // mountNotebook defaults to visible: false, so no status event starts the kernel.
  assert.deepEqual(kernelState(), off)
  assert.deepEqual(toolbarState(), { state: 'off', dot: 'dsh-bsb-ipynb-kernel-dot' })
  await app.settle()
  const request = app.run()
  assert.ok(request)
  assert.deepEqual(kernelState(), { running: false, ready: false, busy: true, executionState: 'busy' })
  assert.deepEqual(toolbarState(), { state: 'busy', dot: 'dsh-bsb-ipynb-kernel-dot is-busy' })

  request.resolve(response({ ok: false, error: { code: 'kernel-unavailable', message: 'unavailable' } }, 503))
  await app.settle()
  assert.deepEqual(kernelState(), off)
  assert.deepEqual(toolbarState(), { state: 'off', dot: 'dsh-bsb-ipynb-kernel-dot' })
  assert.equal(app.toolbar.running, false)
  assert.equal(app.cell.busy, false)
  assert.equal(app.banner?.key, 'kernelUnavailable')
  assert.equal(app.banner?.textKey, 'installHint')
  assert.equal(Object.hasOwn(app.banner, 'text'), false)
  const english = 'No Python interpreter with jupyter_client and ipykernel was found. Install them with: python -m pip install jupyter_client ipykernel'
  assert.equal(app.bannerText, english)
  app.setLocale('zh')
  const chinese = '未找到安装了 jupyter_client 和 ipykernel 的 Python 解释器。 可使用以下命令安装：python -m pip install jupyter_client ipykernel'
  assert.equal(app.bannerText, chinese)
  assert.equal(toolbarState().state, '未启动')

  const retry = app.run()
  assert.ok(retry)
  assert.equal(app.requests('execute').length, 2, 'the failed preflight releases the execution lock')
  retry.resolve(response({ ok: false, error: { code: 'kernel-unavailable', message: 'unavailable' } }, 503))
  await app.settle()
  assert.deepEqual(kernelState(), off)
  assert.equal(app.bannerText, chinese)
})

test('a kernel death is not undone by the terminal reply it precedes', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  const request = app.run()
  const stream = executionStream()
  request.resolve(stream.response)
  await app.settle()
  stream.emit({ type: 'kernel_died', message: 'kernel crashed' })
  await app.settle()
  assert.equal(app.toolbar.kernel.running, false)
  stream.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: false, status: 'error' })
  stream.end()
  await app.settle()
  assert.equal(app.toolbar.kernel.running, false, 'the synthetic terminal reply must not revive a dead kernel')
  assert.equal(app.toolbar.kernel.executionState, 'none')
})

test('raw cells become editable in place', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.cell.onType('cell-1', 'raw')
  await app.settle()
  assert.equal(app.cell.cell.cell_type, 'raw')
  app.cell.onEdit('cell-1')
  await app.settle()
  assert.equal(app.cell.editing, true)
  const cellView = app.component('CellView')
  const textarea = findElement(cellView.type(cellView.props), (value) => value.type === 'textarea')
  assert.ok(textarea, 'editing a raw cell renders its source textarea')
  app.cell.onSource('cell-1', 'raw text')
  await app.settle()
  assert.equal(app.cell.cell.source, 'raw text')
  assert.equal(app.cell.editing, true)
})

test('the empty-file hint disappears once the notebook is saved', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.reload({ ...notebookData(), emptyFile: true })
  await app.settle()
  assert.ok(app.find((value) => value.props?.className === 'dsh-bsb-ipynb-hint'), 'empty-file hint is visible')
  assert.equal(app.banner?.reason, 'empty-file')
  app.edit('print("saved")')
  const request = app.save()
  assert.ok(request)
  request.resolve(response({ ok: true, value: { version: 'v2', size: 42 } }))
  await app.settle()
  assert.equal(app.find((value) => value.props?.className === 'dsh-bsb-ipynb-hint'), null,
    'a successful save clears the empty-file hint')
  assert.equal(app.banner, null, 'a successful save clears the empty-file banner')
  assert.equal(app.toolbar.dirty, false)
})

test('the open-as-empty hint also clears after a successful save', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.reload({ status: 'invalid', error: 'broken', version: 'v1' })
  await app.settle()
  const open = app.find((value) => value.props?.title === 'Open as empty notebook')
  assert.ok(open, 'the invalid document offers the open-as-empty action')
  open.props.onClick()
  await app.settle()
  assert.equal(app.banner?.reason, 'empty-file')
  app.edit('print("saved")')
  const request = app.save()
  assert.ok(request)
  request.resolve(response({ ok: true, value: { version: 'v2', size: 42 } }))
  await app.settle()
  assert.equal(app.banner, null, 'saving clears the open-as-empty hint')
  assert.equal(app.toolbar.dirty, false)
})

test('a malformed attachment reference degrades instead of crashing the render', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  const data = notebookData()
  data.notebook.cells[0] = {
    cell_type: 'markdown',
    id: 'cell-1',
    metadata: {},
    source: 'before ![x](attachment:%ZZ) after',
  }
  app.reload(data)
  await app.settle()
  assert.equal(app.cell.cell.cell_type, 'markdown')
  const cellView = app.component('CellView')
  const rendered = cellView.type(cellView.props)
  const markdown = findElement(rendered, (value) => (
    typeof value.props?.dangerouslySetInnerHTML?.__html === 'string' &&
    value.props.dangerouslySetInnerHTML.__html.includes('dsh-bsb-ipynb-missing-image')
  ))
  assert.ok(markdown, 'the malformed attachment renders as a missing image instead of throwing')
})

// ---------------------------------------------------------------------------
// Reading-mode keyboard shortcuts (L-21)
// ---------------------------------------------------------------------------

const OFF_KERNEL = { running: false, ready: false, busy: false, python: null, executionState: 'none' }

function fakeTarget(tagName, cellId = null, extra = {}) {
  const container = cellId
    ? { getAttribute: (name) => (name === 'data-cell-id' ? cellId : null), parentNode: null }
    : null
  return { tagName, getAttribute: () => null, parentNode: container, ...extra }
}

test('reading-mode Ctrl+Enter runs the focused cell from the window listener', async (t) => {
  const app = mountNotebook(t, { visible: true })
  await app.settle()
  assert.equal(app.keyListenerCount, 1, 'one global keydown listener while the viewer is mounted')
  const event = app.dispatchKey({ key: 'Enter', ctrlKey: true, target: fakeTarget('PRE', 'cell-1') })
  app.flush()
  assert.equal(event.defaultPrevented, true)
  const request = app.requests('execute').at(-1)
  assert.ok(request, 'a focused cell runs without entering edit mode')
  assert.equal(request.body.cellId, 'cell-1')
})

test('reading-mode Cmd+Enter falls back to the most recently edited or run cell', async (t) => {
  const app = mountNotebook(t, { visible: true })
  await app.settle()
  app.edit('print("edited")')
  const event = app.dispatchKey({ key: 'Enter', metaKey: true, target: fakeTarget('BODY') })
  app.flush()
  assert.equal(event.defaultPrevented, true)
  const request = app.requests('execute').at(-1)
  assert.ok(request, 'the recently edited cell is the target when focus is not inside a cell')
  assert.equal(request.body.cellId, 'cell-1')
})

test('reading-mode shortcuts never guess a cell to run', async (t) => {
  const app = mountNotebook(t, { visible: true })
  await app.settle()
  const event = app.dispatchKey({ key: 'Enter', ctrlKey: true, target: fakeTarget('BODY') })
  app.flush()
  assert.equal(app.requests('execute').length, 0, 'no focused or recently used cell means no run')
  assert.equal(event.defaultPrevented, false, 'an unhandled key leaves the browser default alone')
})

test('reading-mode Ctrl+S saves and prevents the browser save dialog', async (t) => {
  const app = mountNotebook(t, { visible: true })
  await app.settle()
  // CapsLock case: the browser reports event.key === 'S'.
  const event = app.dispatchKey({ key: 'S', ctrlKey: true, target: fakeTarget('BODY') })
  app.flush()
  assert.equal(event.defaultPrevented, true, 'the browser save dialog must be blocked')
  assert.equal(app.requests('save').length, 1)
})

test('reading-mode Ctrl+S is prevented but does not save an unusable notebook', async (t) => {
  const app = mountNotebook(t, { visible: true })
  await app.settle()
  app.reload({ status: 'invalid', error: 'broken', version: 'v1' })
  await app.settle()
  const event = app.dispatchKey({ key: 's', ctrlKey: true, target: fakeTarget('BODY') })
  assert.equal(event.defaultPrevented, true, 'the browser save dialog is blocked even on the error card')
  assert.equal(app.requests('save').length, 0, 'nothing is saved when there is no usable notebook')
})

test('reading-mode shortcuts ignore IME composition and already handled events', async (t) => {
  const app = mountNotebook(t, { visible: true })
  await app.settle()
  const ime = app.dispatchKey({ key: 's', ctrlKey: true, isComposing: true, target: fakeTarget('BODY') })
  assert.equal(ime.defaultPrevented, false)
  assert.equal(app.requests('save').length, 0)

  const handled = app.dispatchKey({ key: 'Enter', ctrlKey: true, defaultPrevented: true, target: fakeTarget('PRE', 'cell-1') })
  app.flush()
  assert.equal(app.requests('execute').length, 0, 'the cell editor already handled the event')
  assert.equal(handled.defaultPrevented, true)

  const editing = app.dispatchKey({ key: 'Enter', ctrlKey: true, target: fakeTarget('TEXTAREA') })
  app.flush()
  assert.equal(app.requests('execute').length, 0, 'editing targets keep their own textarea handler')
  assert.equal(editing.defaultPrevented, false)
})

test('editing shortcuts do not fire twice through the window listener', async (t) => {
  const app = mountNotebook(t, { visible: true })
  await app.settle()
  app.cell.onEdit('cell-1')
  app.flush()
  const editor = () => {
    const view = app.component('CellView')
    return findElement(view.type(view.props), (value) => value.type === 'textarea')
  }
  const makeEvent = (key, extra = {}) => ({
    key,
    target: { tagName: 'TEXTAREA' },
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    ...extra,
  })

  const saveEvent = makeEvent('s', { ctrlKey: true })
  editor().props.onKeyDown(saveEvent)
  app.flush()
  assert.equal(saveEvent.defaultPrevented, true, 'the textarea handler handles and prevents Ctrl+S')
  assert.equal(app.requests('save').length, 1)
  app.dispatchKey(saveEvent)
  app.flush()
  assert.equal(app.requests('save').length, 1, 'the window listener skips the already-handled save')

  const runEvent = makeEvent('Enter', { ctrlKey: true })
  editor().props.onKeyDown(runEvent)
  app.flush()
  assert.equal(runEvent.defaultPrevented, true)
  assert.equal(app.requests('execute').length, 1)
  app.dispatchKey(runEvent)
  app.flush()
  assert.equal(app.requests('execute').length, 1, 'the window listener skips the already-handled run')
})

test('the window keydown listener is removed on unmount', async (t) => {
  const app = mountNotebook(t, { visible: true })
  await app.settle()
  assert.equal(app.keyListenerCount, 1)
  app.unmount()
  assert.equal(app.keyListenerCount, 0, 'unmount removes the global listener')
  const event = app.dispatchKey({ key: 's', ctrlKey: true, target: fakeTarget('BODY') })
  assert.equal(event.defaultPrevented, false)
  assert.equal(app.requests('save').length, 0)
})

test('a hidden viewer does not handle window shortcuts', async (t) => {
  const app = mountNotebook(t) // mountNotebook defaults to visible: false
  await app.settle()
  assert.equal(app.keyListenerCount, 1, 'the listener is still mounted for the lifetime of the viewer')
  const save = app.dispatchKey({ key: 's', ctrlKey: true, target: fakeTarget('BODY') })
  assert.equal(save.defaultPrevented, false, 'a hidden viewer must not block the host/browser save')
  assert.equal(app.requests('save').length, 0)
  const run = app.dispatchKey({ key: 'Enter', ctrlKey: true, target: fakeTarget('PRE', 'cell-1') })
  app.flush()
  assert.equal(run.defaultPrevented, false)
  assert.equal(app.requests('execute').length, 0)
})

test('shortcuts become active when the viewer turns visible', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  const hidden = app.dispatchKey({ key: 'S', ctrlKey: true, target: fakeTarget('BODY') })
  assert.equal(hidden.defaultPrevented, false)
  assert.equal(app.requests('save').length, 0)
  app.setVisible(true)
  await app.settle()
  const shown = app.dispatchKey({ key: 'S', ctrlKey: true, target: fakeTarget('BODY') })
  app.flush()
  assert.equal(shown.defaultPrevented, true, 'the now-active viewer handles the shortcut again')
  assert.equal(app.requests('save').length, 1)
})

test('auto-repeat keydown does not trigger shortcuts again', async (t) => {
  const app = mountNotebook(t, { visible: true })
  await app.settle()
  const save = app.dispatchKey({ key: 's', ctrlKey: true, repeat: true, target: fakeTarget('BODY') })
  app.flush()
  assert.equal(save.defaultPrevented, false, 'a held key is not a new shortcut')
  assert.equal(app.requests('save').length, 0)
  const run = app.dispatchKey({ key: 'Enter', ctrlKey: true, repeat: true, target: fakeTarget('PRE', 'cell-1') })
  app.flush()
  assert.equal(run.defaultPrevented, false)
  assert.equal(app.requests('execute').length, 0)
  const firstPress = app.dispatchKey({ key: 's', ctrlKey: true, repeat: false, target: fakeTarget('BODY') })
  app.flush()
  assert.equal(firstPress.defaultPrevented, true, 'the initial non-repeat press still works')
  assert.equal(app.requests('save').length, 1)
})

// ---------------------------------------------------------------------------
// Kernel status generation / late GET handling (M-12)
// ---------------------------------------------------------------------------

test('a late /status response cannot overwrite a kernel death and its terminal reply', async (t) => {
  const app = mountNotebook(t, { deferStatus: true })
  await app.settle()
  const stale = app.requests('status').at(-1)
  assert.ok(stale, 'the initial status GET is deferred')
  const request = app.run()
  const stream = executionStream()
  request.resolve(stream.response)
  await app.settle()
  assert.equal(stale.init.signal.aborted, true, 'starting a run invalidates the pre-run status GET')
  stream.emit({ type: 'kernel_died', message: 'kernel crashed' })
  await app.settle()
  stream.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: false, status: 'error' })
  await app.settle()
  assert.equal(app.toolbar.kernel.running, false)
  assert.equal(app.toolbar.kernel.busy, false)
  stale.resolve(response({ ok: true, value: { running: true, ready: true, busy: true, executionState: 'busy', python: '/python' } }))
  await app.settle()
  assert.equal(app.toolbar.kernel.running, false, 'a pre-death status cannot revive the kernel')
  assert.equal(app.toolbar.kernel.busy, false)
  assert.equal(app.toolbar.kernel.executionState, 'none')
  stream.end()
  await app.settle()
})

test('a fatal stream error also advances the kernel generation', async (t) => {
  const app = mountNotebook(t, { deferStatus: true })
  await app.settle()
  const stale = app.requests('status').at(-1)
  const request = app.run()
  const stream = executionStream()
  request.resolve(stream.response)
  await app.settle()
  stream.emit({ type: 'fatal', message: 'connection lost' })
  await app.settle()
  stale.resolve(response({ ok: true, value: { running: true, ready: true, busy: true, executionState: 'busy', python: '/python' } }))
  await app.settle()
  assert.equal(app.toolbar.kernel.running, false, 'a pre-fatal status GET is ignored')
  stream.end()
  await app.settle()
})

test('a status response that raced shutdown cannot revive the kernel', async (t) => {
  const app = mountNotebook(t, { deferStatus: true })
  await app.settle()
  const stale = app.requests('status').at(-1)
  app.toolbar.onShutdown()
  await app.settle()
  assert.equal(stale.init.signal.aborted, true, 'shutdown invalidates the in-flight status GET')
  app.requests('shutdown').at(-1).resolve(response({ ok: true, value: {} }))
  await app.settle()
  stale.resolve(response({ ok: true, value: { running: true, ready: true, busy: true, executionState: 'busy', python: '/python' } }))
  await app.settle()
  assert.equal(app.toolbar.kernel.running, false, 'shutdown keeps the authoritative off state')
  assert.equal(app.toolbar.kernel.busy, false)
})

test('restart advances the kernel generation and refreshes with the replacement state', async (t) => {
  const app = mountNotebook(t, { deferStatus: true })
  await app.settle()
  const stale = app.requests('status').at(-1)
  app.toolbar.onRestart()
  await app.settle()
  app.requests('restart').at(-1).resolve(response({ ok: true, value: { python: '/python2' } }))
  await app.settle()
  const fresh = app.requests('status').at(-1)
  assert.notEqual(fresh, stale, 'the completed restart issues its own status GET')
  stale.resolve(response({ ok: true, value: { running: true, ready: true, busy: true, executionState: 'busy', python: '/python' } }))
  await app.settle()
  assert.equal(app.toolbar.kernel.running, false, 'the pre-restart status is ignored')
  fresh.resolve(response({ ok: true, value: { running: true, ready: true, busy: false, executionState: 'idle', python: '/python2' } }))
  await app.settle()
  assert.equal(app.toolbar.kernel.python, '/python2', 'the replacement kernel state is committed')
  assert.equal(app.toolbar.kernel.busy, false)
})

test('concurrent status GETs only commit the latest response', async (t) => {
  const app = mountNotebook(t, { deferStatus: true })
  await app.settle()
  const first = app.requests('status').at(-1)
  app.setVisible(true)
  await app.settle()
  assert.equal(app.requests('status').length, 2, 'returning to a visible notebook refreshes the kernel')
  const second = app.requests('status').at(-1)
  assert.notEqual(second, first)
  assert.equal(first.init.signal.aborted, true, 'the newer refresh aborts the in-flight GET')
  second.resolve(response({ ok: true, value: OFF_KERNEL }))
  await app.settle()
  assert.equal(app.toolbar.kernel.running, false)
  first.resolve(response({ ok: true, value: { running: true, ready: true, busy: true, executionState: 'busy', python: '/python' } }))
  await app.settle()
  assert.equal(app.toolbar.kernel.running, false, 'the older concurrent GET loses to the latest one')
  assert.equal(app.toolbar.kernel.busy, false)
})

test('reload advances the kernel generation and ignores a status GET from the old document', async (t) => {
  const app = mountNotebook(t, { deferStatus: true })
  await app.settle()
  const stale = app.requests('status').at(-1)
  app.reload()
  await app.settle()
  assert.equal(stale.init.signal.aborted, true, 'adopting a document invalidates its status GET')
  stale.resolve(response({ ok: true, value: { running: true, ready: true, busy: true, executionState: 'busy', python: '/python' } }))
  await app.settle()
  assert.equal(app.toolbar.kernel.running, false, 'the reloaded document never shows the stale running state')
})

test('a hidden notebook refreshes the kernel when it becomes visible again', async (t) => {
  const app = mountNotebook(t, { deferStatus: true })
  await app.settle()
  const initial = app.requests('status').at(-1)
  initial.resolve(response({ ok: true, value: OFF_KERNEL }))
  await app.settle()
  assert.equal(app.requests('status').length, 1, 'a hidden notebook does not poll')
  app.setVisible(true)
  await app.settle()
  assert.equal(app.requests('status').length, 2, 'becoming visible refreshes the kernel once')
  app.requests('status').at(-1).resolve(response({ ok: true, value: { running: true, ready: true, busy: false, executionState: 'idle', python: '/python' } }))
  await app.settle()
  assert.equal(app.toolbar.kernel.running, true)
  assert.equal(app.toolbar.kernel.busy, false)
})
