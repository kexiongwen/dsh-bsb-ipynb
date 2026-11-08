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
  let confirmResult = true
  const confirmations = []
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
    customData: options.customData || notebookData(),
    onReload: options.hostReload === false ? undefined : () => { hostReloads += 1 },
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
      localStorage: { getItem() { return null }, setItem() {} },
      confirm(message) { confirmations.push(message); return confirmResult },
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
    get confirmations() { return confirmations },
    setConfirm(value) { confirmResult = value },
    requests: (route) => requests.filter((request) => request.route === route),
    loadReplacement() { return moduleExports.__test.readNotebook(props.ctx, props.path, props.scope) },
    edit(source = 'print("edited")') { api.cell.onSource('cell-1', source); flush() },
    run() { api.cell.onRun('cell-1'); flush(); return api.requests('execute').at(-1) },
    runWithoutCommit() { api.cell.onRun('cell-1'); return api.requests('execute').at(-1) },
    save() { api.toolbar.onSave(); flush(); return api.requests('save').at(-1) },
    async reload(data = notebookData('FRESH', 'v2')) {
      api.toolbar.onReload()
      await settle()
      const request = api.requests('read').at(-1)
      assert.ok(request, 'the plugin reads after confirmation')
      request.resolve(response({ ok: true, value: data }))
      await settle()
    },
    receive(data) {
      props = { ...props, customData: data }
      needsRender = true
      flush()
    },
    cancelReload() { confirmResult = false; api.toolbar.onReload(); flush(); confirmResult = true },
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
  await app.reload()
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
    await app.reload()
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

test('cancelling the reload prompt keeps the current execution alive', async (t) => {
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

for (const staleOutcome of ['success', 'error']) {
  test(`fallback reload ignores an older ${staleOutcome} response that arrives last`, async (t) => {
    const app = mountNotebook(t, { hostReload: false })
    await app.settle()
    app.toolbar.onReload()
    app.toolbar.onReload()
    const reads = app.requests('read')
    assert.equal(reads.length, 2)
    assert.equal(app.reloadCount, 0, 'this scenario exercises only the no-host fallback')

    reads[1].resolve(response({ ok: true, value: notebookData('NEWER', 'v2') }))
    await app.settle()
    assert.equal(app.cell.cell.outputs[0].text, 'NEWER')
    if (staleOutcome === 'success') {
      reads[0].resolve(response({ ok: true, value: notebookData('OLDER', 'v1') }))
    } else {
      reads[0].resolve(response({ ok: false, error: { code: 'read-blocked', message: 'STALE ERROR' } }, 409))
    }
    await app.settle()
    assert.equal(app.cell.cell.outputs[0].text, 'NEWER', 'the older request must not replace the adopted document')
    assert.equal(app.toolbar.dirty, false)
    assert.equal(app.banner, null)
  })
}

for (const outcome of ['conflict', 'failure', 'success']) {
  test(`reload waits for an in-flight save ${outcome} before reading the disk`, async (t) => {
    const app = mountNotebook(t)
    await app.settle()
    app.edit('old draft')
    const oldSave = app.save()
    app.toolbar.onReload()
    await app.settle()
    assert.equal(app.reloadCount, 0, 'plugin reload must not delegate to the host callback')
    assert.equal(app.requests('read').length, 0, 'reload must not read while the save can still commit')
    app.save()
    assert.equal(app.requests('save').length, 1, 'waiting for reload does not start another save')

    // Successful/conflict responses follow the server write. The failure case
    // separately checks that a rejected transport releases the reload wait;
    // server-side ordering of an unfinished write is covered by I/O tests.
    const disk = notebookData('LATEST DISK', 'v2')
    disk.notebook.cells[0].source = outcome === 'success' ? 'old draft' : 'external draft'
    if (outcome === 'conflict') oldSave.resolve(response({ ok: false, error: { code: 'write-conflict', message: 'CONFLICT', details: { version: 'v2' } } }, 409))
    else if (outcome === 'failure') oldSave.reject(new Error('NETWORK FAILURE'))
    else oldSave.resolve(response({ ok: true, value: { version: 'v2' } }))
    await app.settle()
    assert.equal(app.reloadCount, 0, 'plugin reload owns confirmation')
    assert.equal(app.requests('read').length, 1)
    app.requests('read')[0].resolve(response({ ok: true, value: disk }))
    await app.settle()
    assert.equal(app.cell.cell.source, disk.notebook.cells[0].source)
    assert.equal(app.cell.cell.outputs[0].text, 'LATEST DISK')
    assert.equal(app.toolbar.dirty, false)
    assert.equal(app.toolbar.conflict, null)
    assert.equal(app.banner, null)
    app.edit('next draft')
    const nextSave = app.save()
    assert.equal(nextSave.body.baseVersion, 'v2', 'the next save uses the actual latest disk version')
    nextSave.resolve(response({ ok: true, value: { version: 'v3' } }))
    await app.settle()
  })
}

test('reload cannot replace edits saved while its read was in flight', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.toolbar.onReload()
  app.edit('newer draft')
  const save = app.save()
  save.resolve(response({ ok: true, value: { version: 'v2' } }))
  await app.settle()
  assert.equal(app.toolbar.dirty, false)
  app.requests('read')[0].resolve(response({ ok: true, value: notebookData('STALE', 'v1') }))
  await app.settle()
  assert.equal(app.cell.cell.source, 'newer draft', 'even a now-clean draft must survive the older read')
  app.edit('next draft')
  assert.equal(app.save().body.baseVersion, 'v2')
})

test('only the latest queued reload runs after saving, and cancellation does not lock the editor', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.edit('saved draft')
  const save = app.save()
  app.toolbar.onReload()
  app.toolbar.onReload()
  save.resolve(response({ ok: true, value: { version: 'v2' } }))
  await app.settle()
  assert.equal(app.requests('read').length, 1, 'superseded clicks do not issue multiple reads')
  app.requests('read')[0].resolve(response({ ok: true, value: notebookData('LATEST', 'v2') }))
  await app.settle()
  app.edit('unsaved draft')
  app.cancelReload()
  assert.equal(app.requests('read').length, 1, 'cancelling confirmation does not start another read')
  assert.equal(app.cell.cell.source, 'unsaved draft')
  assert.equal(app.toolbar.dirty, true)
  const nextSave = app.save()
  assert.equal(app.requests('save').length, 2, 'cancellation must not retain a save lock')
  assert.equal(nextSave.body.baseVersion, 'v2')
  assert.equal(nextSave.body.notebook.cells[0].source, 'unsaved draft')
})

test('editing while reload waits for a save cancels that reload and keeps autosave available', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.edit('saved draft')
  const save = app.save()
  app.toolbar.onReload()
  app.edit('newer draft')
  save.resolve(response({ ok: true, value: { version: 'v2' } }))
  await app.settle()
  assert.equal(app.reloadCount, 0)
  assert.equal(app.cell.cell.source, 'newer draft')
  assert.equal(app.toolbar.dirty, true)
  app.fireTimer(1500)
  assert.equal(app.requests('save').length, 2)
  assert.equal(app.requests('save')[1].body.baseVersion, 'v2')
})

test('unmount cancels a reload waiting for a save without aborting the write', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.edit()
  const save = app.save()
  app.toolbar.onReload()
  app.unmount()
  const replacement = app.loadReplacement()
  await settleWithoutCommit()
  assert.equal(app.requests('read').length, 0, 'the replacement waits even after the old component is gone')
  save.resolve(response({ ok: true, value: { version: 'v2' } }))
  await settleWithoutCommit()
  assert.equal(app.reloadCount, 0, 'a disposed viewer must not invoke its old host reload callback')
  assert.equal(app.requests('read').length, 1, 'only the replacement loader reads after saving')
  app.requests('read')[0].resolve(response({ ok: true, value: notebookData('COMMITTED', 'v2') }))
  assert.equal((await replacement).version, 'v2')
})

test('confirmed reload blocks autosave and manual save until its read is adopted', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.edit('unsaved draft')
  assert.equal(app.timersFor(1500).length, 1)
  app.toolbar.onReload()
  await app.settle()
  assert.equal(app.confirmations.length, 1)
  assert.equal(app.timersFor(1500).length, 0)
  app.save()
  assert.equal(app.requests('save').length, 0)
  app.requests('read')[0].resolve(response({ ok: true, value: notebookData('DISK', 'v2') }))
  await app.settle()
  assert.equal(app.cell.cell.outputs[0].text, 'DISK')
  assert.equal(app.toolbar.dirty, false)
  app.edit('new draft')
  assert.equal(app.save().body.baseVersion, 'v2')
})

test('execute_reply cannot invalidate a confirmed reload while its disk read is pending', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  const execution = app.run()
  const stream = executionStream()
  execution.resolve(stream.response)
  await app.settle()
  app.toolbar.onReload()
  await app.settle()
  assert.equal(app.confirmations.length, 1, 'running results need discard confirmation')
  stream.emit({ type: 'stream', cell_id: 'cell-1', text: 'UNSAVED RESULT' })
  stream.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: true, execution_count: 2 })
  stream.end()
  await app.settle()
  app.save()
  assert.equal(app.requests('save').length, 0)
  assert.equal(app.timersFor(1500).length, 0)
  app.requests('read')[0].resolve(response({ ok: true, value: notebookData('DISK', 'v2') }))
  await app.settle()
  assert.equal(app.cell.cell.outputs[0].text, 'DISK')
  assert.equal(app.toolbar.dirty, false)
  app.edit('next draft')
  assert.equal(app.save().body.baseVersion, 'v2')
})

test('cancelled reload releases autosave and cannot swallow the next independent host snapshot', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.edit('keep')
  app.cancelReload()
  await app.settle()
  assert.equal(app.requests('read').length, 0)
  assert.equal(app.timersFor(1500).length, 1)
  app.fireTimer(1500)
  app.requests('save')[0].resolve(response({ ok: true, value: { version: 'v2' } }))
  await app.settle()
  app.receive(notebookData('EXTERNAL', 'v3'))
  assert.equal(app.cell.cell.outputs[0].text, 'EXTERNAL')
  app.edit('after external refresh')
  assert.equal(app.save().body.baseVersion, 'v3')
})

test('starting a new execution cancels a previously confirmed reload without discarding the new result', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.toolbar.onReload()
  const read = app.requests('read')[0]
  const execution = app.run()
  const stream = executionStream()
  execution.resolve(stream.response)
  await app.settle()
  assert.equal(read.init.signal.aborted, true)
  stream.emit({ type: 'stream', cell_id: 'cell-1', text: 'NEW RESULT' })
  stream.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: true, execution_count: 2 })
  stream.end()
  await app.settle()
  read.resolve(response({ ok: true, value: notebookData('OLD DISK', 'v1') }))
  await app.settle()
  assert.equal(app.cell.cell.outputs[0].text, 'NEW RESULT')
  assert.equal(app.toolbar.dirty, true)
  assert.ok(app.save(), 'the cancelled reload does not retain a save barrier')
})

test('unmount aborts a pending reload and prevents adopting its late response', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.toolbar.onReload()
  const read = app.requests('read')[0]
  app.unmount()
  assert.equal(read.init.signal.aborted, true)
  read.resolve(response({ ok: true, value: notebookData('LATE', 'v2') }))
  await settleWithoutCommit()
  assert.equal(app.requests('save').length, 0)
})

test('fallback reload preserves edits made after its read started', async (t) => {
  const app = mountNotebook(t, { hostReload: false })
  await app.settle()
  app.toolbar.onReload()
  app.edit('keep this draft')
  app.requests('read')[0].resolve(response({ ok: true, value: notebookData('STALE', 'v1') }))
  await app.settle()
  assert.equal(app.cell.cell.source, 'keep this draft')
  assert.equal(app.toolbar.dirty, true)
})

for (const outcome of ['success', 'conflict', 'failure']) {
  test(`an unsolicited host snapshot cannot replace a document during save ${outcome}`, async (t) => {
    const app = mountNotebook(t, { visible: true })
    await app.settle()
    // An independent host response has no causal link to this pending write.
    // Keep its snapshot until the write settles and a confirmed reload reads it.
    app.dispatchKey({ key: 's', ctrlKey: true, target: fakeTarget('BODY') })
    const oldSave = app.requests('save')[0]
    app.receive(notebookData('UNORDERED', 'v2'))
    assert.equal(app.cell.cell.outputs[0].text, 'OLD')
    app.save()
    assert.equal(app.requests('save').length, 1)
    if (outcome === 'success') oldSave.resolve(response({ ok: true, value: { version: 'v2' } }))
    else if (outcome === 'conflict') oldSave.resolve(response({ ok: false, error: { code: 'write-conflict', details: { version: 'v2' } } }, 409))
    else oldSave.reject(new Error('NETWORK FAILURE'))
    await app.settle()
    await app.reload(notebookData('FRESH', 'v2'))
    app.edit('fresh draft')
    const currentSave = app.save()
    assert.equal(currentSave.body.baseVersion, 'v2')
    assert.equal(app.cell.cell.outputs[0].text, 'FRESH')
    currentSave.resolve(response({ ok: true, value: { version: 'v3' } }))
    await app.settle()
    app.edit('next draft')
    assert.equal(app.save().body.baseVersion, 'v3')
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
  await app.reload()
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
  await app.reload(twoCells)
  const oldBatch = app.toolbar.onRunAll()
  app.flush()
  const oldStream = executionStream()
  app.requests('execute')[0].resolve(oldStream.response)
  await app.settle()
  await app.reload({ ...twoCells, version: 'v2' })
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
  await app.reload()
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
  await app.reload(data)
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
  await app.reload(notebookData('x'.repeat(33 * MiB), 'v2'))
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
  await app.reload(data)
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
    const app = mountNotebook(t, { locale: true })
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
    await app.reload(data)
    await app.settle()
    app.edit('print("edited")')
    app.save()
    await app.settle()
    assert.equal(app.requests('save').length, 0, `${scenario}: over-complex metadata is blocked before upload`)
    assert.equal(app.banner?.reason, 'metadata-too-complex', `${scenario}: the preflight failure is stored in banner state`)
    assert.equal(app.banner.key, 'metadataTooComplex', `${scenario}: the banner stores a translatable key`)
    assert.equal(Object.hasOwn(app.banner, 'text'), false, `${scenario}: static text must not be frozen into banner state`)
    const english = app.bannerText
    assert.match(english, /metadata is too complex/)
    app.setLocale('zh')
    assert.match(app.bannerText, /metadata 过于复杂/)
    app.setLocale('en')
    assert.equal(app.bannerText, english, `${scenario}: the existing banner follows locale switches`)

    if (location === 'output') {
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
      assert.ok(reload, `${scenario}: the banner provides the reload action`)
      assert.equal(clearAll, null, `${scenario}: clearing outputs cannot repair notebook or cell metadata`)
      const reloadCount = app.requests('read').length
      reload.props.onClick()
      await app.settle()
      assert.equal(app.requests('read').length, reloadCount + 1, `${scenario}: the action performs the confirmed plugin reload`)
    }
  }
})

test('JSON preflight blocks upload and offers recovery that matches the offending data', async (t) => {
  for (const attachment of [false, true]) {
    const app = mountNotebook(t, { locale: true })
    await app.settle()
    const data = notebookData('OLD', 'v2')
    const cell = data.notebook.cells[0]
    const payload = { 'application/vnd.example+json': nestedMetadata(101) }
    if (attachment) {
      cell.cell_type = 'markdown'
      delete cell.outputs
      delete cell.execution_count
      cell.attachments = { 'data.json': payload }
    } else {
      cell.outputs = [{ output_type: 'display_data', data: payload, metadata: {} }]
    }
    await app.reload(data)
    await app.settle()
    app.edit('edited')
    app.save()
    await app.settle()
    assert.equal(app.requests('save').length, 0, 'invalid JSON never reaches upload serialization')
    assert.equal(app.banner?.reason, 'json-too-complex')
    assert.equal(app.banner.key, 'jsonTooComplex')
    assert.equal(app.banner.action, attachment ? 'reload' : 'clear-outputs')
    assert.equal(app.timersFor(1500).length, 0, 'autosave does not retry a rejected structure')
    assert.match(app.bannerText, /JSON/)
    const banner = app.component('Banner')
    const rendered = banner.type(banner.props)
    const clear = findElement(rendered, (value) => value.props?.title === 'Clear all outputs')
    if (attachment) {
      assert.equal(clear, null, 'clearing outputs cannot fix attachments')
      const reload = findElement(rendered, (value) => value.props?.title === 'Reload')
      assert.ok(reload)
      const count = app.requests('read').length
      reload.props.onClick()
      await app.settle()
      assert.equal(app.requests('read').length, count + 1)
    } else {
      assert.ok(clear)
      clear.props.onClick()
      await app.settle()
      assert.equal(app.banner, null)
      const retry = app.save()
      assert.ok(retry)
      assert.equal(retry.body.notebook.cells[0].outputs.length, 0)
      retry.resolve(response({ ok: true, value: { version: 'v3', size: 64 } }))
      await app.settle()
      assert.equal(app.toolbar.dirty, false)
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
  await app.reload(twoCells)
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
  await app.reload({ ...notebookData(), emptyFile: true })
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

test('error adoption clears dirty state so a later host snapshot can be adopted', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.edit('unsaved draft')
  await app.reload({ status: 'invalid', error: 'broken', version: 'v2' })
  await app.settle()

  app.receive(notebookData('RECOVERED', 'v3'))
  await app.settle()
  assert.equal(app.cell.cell.outputs[0].text, 'RECOVERED', 'the invalid response must not leave the old draft blocking adoption')
  assert.equal(app.toolbar.dirty, false)
})

test('open as empty clears an old conflict and preserves the invalid file version for CAS', async (t) => {
  const app = mountNotebook(t)
  await app.settle()
  app.edit('conflicted draft')
  const failed = app.save()
  failed.resolve(response({ ok: false, error: { code: 'write-conflict', message: 'conflict', details: { version: 'v2' } } }, 409))
  await app.settle()
  await app.reload({ status: 'invalid', error: 'broken', version: 'v3' })
  await app.settle()

  const open = app.find((value) => value.props?.title === 'Open as empty notebook')
  assert.ok(open, 'the invalid document offers the open-as-empty action')
  open.props.onClick()
  await app.settle()
  assert.equal(app.banner?.reason, 'empty-file')
  assert.equal(app.toolbar.conflict, null)
  assert.equal(app.toolbar.dirty, false)
  app.edit('replacement draft')
  const request = app.save()
  assert.equal(app.requests('save').length, 2, 'the old conflict must not block the replacement document')
  assert.equal(request.body.baseVersion, 'v3', 'the first save still guards the invalid on-disk file')
  request.resolve(response({ ok: true, value: { version: 'v4', size: 42 } }))
  await app.settle()
  assert.equal(app.toolbar.dirty, false)
  assert.equal(app.banner, null, 'saving clears the open-as-empty hint')
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
  await app.reload(data)
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
  await app.reload({ status: 'invalid', error: 'broken', version: 'v1' })
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

for (const outcome of ['success', 'kernel-unavailable']) {
  test(`a late shutdown ${outcome} cannot overwrite a newer executing kernel`, async (t) => {
    const app = mountNotebook(t, { deferStatus: true })
    await app.settle()
    app.requests('status')[0].resolve(response({ ok: true, value: { running: true, ready: true, busy: false, python: '/python', executionState: 'idle' } }))
    await app.settle()
    app.toolbar.onShutdown()
    const execution = app.run()
    const stream = executionStream()
    execution.resolve(stream.response)
    await app.settle()
    stream.emit({ type: 'status', cell_id: 'cell-1', execution_state: 'busy' })
    await app.settle()

    const shutdown = app.requests('shutdown')[0]
    if (outcome === 'success') shutdown.resolve(response({ ok: true, value: {} }))
    else shutdown.resolve(response({ ok: false, error: { code: 'kernel-unavailable', message: 'already stopped' } }, 503))
    await app.settle()
    assert.equal(app.toolbar.running, true)
    assert.equal(app.toolbar.kernel.running, true, 'the new run keeps its authoritative running state')
    assert.equal(app.toolbar.kernel.busy, true)
    assert.equal(app.toolbar.kernel.executionState, 'busy')
    stream.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: true, execution_count: 2 })
    stream.end()
    await app.settle()
  })
}

test('a late shutdown success cannot overwrite the kernel state after reload', async (t) => {
  const app = mountNotebook(t, { deferStatus: true })
  await app.settle()
  app.requests('status')[0].resolve(response({ ok: true, value: { running: true, ready: true, busy: false, python: '/python', executionState: 'idle' } }))
  await app.settle()
  app.toolbar.onShutdown()
  await app.reload()
  await app.settle()
  const kernelAfterReload = JSON.stringify(app.toolbar.kernel)

  app.requests('shutdown')[0].resolve(response({ ok: true, value: {} }))
  await app.settle()
  assert.equal(JSON.stringify(app.toolbar.kernel), kernelAfterReload)
})

test('a late shutdown success cannot overwrite a newer restart', async (t) => {
  const app = mountNotebook(t, { deferStatus: true })
  await app.settle()
  app.requests('status')[0].resolve(response({ ok: true, value: { running: true, ready: true, busy: false, python: '/python', executionState: 'idle' } }))
  await app.settle()
  app.toolbar.onShutdown()
  app.toolbar.onRestart()
  await app.settle()
  app.requests('restart')[0].resolve(response({ ok: true, value: { python: '/python2' } }))
  await app.settle()
  const fresh = app.requests('status').at(-1)
  fresh.resolve(response({ ok: true, value: { running: true, ready: true, busy: false, python: '/python2', executionState: 'idle' } }))
  await app.settle()

  app.requests('shutdown')[0].resolve(response({ ok: true, value: {} }))
  await app.settle()
  assert.equal(app.toolbar.kernel.running, true)
  assert.equal(app.toolbar.kernel.python, '/python2')
})

test('a shutdown error stays visible and only status can confirm that the kernel is off', async (t) => {
  const app = mountNotebook(t, { deferStatus: true })
  await app.settle()
  app.requests('status')[0].resolve(response({ ok: true, value: { running: true, ready: true, busy: false, python: '/python', executionState: 'idle' } }))
  await app.settle()
  app.toolbar.onShutdown()
  app.requests('shutdown')[0].resolve(response({ ok: false, error: { code: 'kernel-unavailable', message: 'already stopped' } }, 503))
  await app.settle()
  assert.equal(app.toolbar.kernel.running, true, 'a generic unavailable error does not prove exit')
  assert.equal(app.banner?.reason, 'shutdown-failed')
  assert.match(app.bannerText, /could not be shut down/)
  const refresh = app.requests('status').at(-1)
  assert.notEqual(refresh, app.requests('status')[0])
  refresh.resolve(response({ ok: true, value: { running: false, ready: false, busy: false, executionState: 'none', python: null } }))
  await app.settle()
  assert.equal(app.toolbar.kernel.running, false)
  assert.equal(app.toolbar.kernel.busy, false)
  assert.equal(app.toolbar.kernel.executionState, 'none')
})

test('shutdown timeout keeps the stopping kernel managed in the UI and permits a successful retry', async (t) => {
  const app = mountNotebook(t, { deferStatus: true, locale: true })
  await app.settle()
  app.requests('status')[0].resolve(response({ ok: true, value: { running: true, ready: true, busy: false, python: '/python', executionState: 'idle' } }))
  await app.settle()
  app.toolbar.onShutdown()
  app.requests('shutdown')[0].resolve(response({ ok: false, error: {
    code: 'kernel-unavailable', message: 'process has not exited', details: { state: 'stopping' },
  } }, 503))
  await app.settle()
  assert.equal(app.toolbar.kernel.running, true)
  assert.equal(app.toolbar.kernel.ready, false)
  assert.equal(app.toolbar.kernel.executionState, 'stopping')
  assert.equal(app.banner?.reason, 'shutdown-failed')
  const toolbar = app.component('Toolbar')
  const label = findElement(toolbar.type(toolbar.props), (value) => value.props?.className === 'dsh-bsb-ipynb-kernel-label')
  assert.equal(label.props.children[0], 'stopping')
  app.setLocale('zh')
  await app.settle()
  assert.match(app.bannerText, /内核未能关闭/)
  const staleStatus = app.requests('status').at(-1)
  app.toolbar.onShutdown()
  app.requests('shutdown')[1].resolve(response({ ok: true, value: {} }))
  await app.settle()
  assert.equal(app.toolbar.kernel.running, false)
  assert.equal(app.banner, null)
  staleStatus.resolve(response({ ok: true, value: { running: true, ready: false, busy: false, executionState: 'stopping' } }))
  await app.settle()
  assert.equal(app.toolbar.kernel.running, false)
})

for (const outcome of ['success', 'timeout']) {
  for (const terminalOrder of ['before', 'after']) {
    test(`shutdown ${outcome} survives the old execution terminal arriving ${terminalOrder} its response`, async (t) => {
      const app = mountNotebook(t, { deferStatus: true })
      await app.settle()
      app.requests('status')[0].resolve(response({ ok: true, value: { running: true, ready: true, busy: false, python: '/python', executionState: 'idle' } }))
      await app.settle()
      const execution = app.run()
      const stream = executionStream()
      execution.resolve(stream.response)
      await app.settle()
      stream.emit({ type: 'status', cell_id: 'cell-1', execution_state: 'busy' })
      await app.settle()
      app.toolbar.onShutdown()
      const terminal = async () => {
        stream.emit({ type: 'error', cell_id: 'cell-1', ename: 'KernelShutdown', evalue: 'Kernel shut down', traceback: [] })
        stream.emit({ type: 'execute_reply', cell_id: 'cell-1', ok: false, execution_count: 2 })
        stream.end()
        await app.settle()
      }
      if (terminalOrder === 'before') await terminal()
      app.requests('shutdown')[0].resolve(outcome === 'success'
        ? response({ ok: true, value: {} })
        : response({ ok: false, error: { code: 'kernel-unavailable', message: 'still alive', details: { state: 'stopping' } } }, 503))
      await app.settle()
      if (terminalOrder === 'after') await terminal()
      assert.equal(app.toolbar.kernel.running, outcome === 'timeout')
      assert.equal(app.toolbar.kernel.executionState, outcome === 'timeout' ? 'stopping' : 'none')
      assert.equal(app.toolbar.running, false)
      assert.equal(app.cell.cell.execution_count, 2, 'terminal bookkeeping is retained')
      if (outcome === 'timeout') {
        assert.equal(app.banner?.reason, 'shutdown-failed')
        assert.match(app.bannerText, /still alive/)
      }
    })
  }
}

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
  await app.reload()
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

function displayNotebookData(count = 3) {
  const data = notebookData()
  data.notebook.cells = Array.from({ length: count }, (_, index) => ({
    id: `cell-${index + 1}`, cell_type: 'code', source: 'display handle', metadata: {},
    execution_count: null, outputs: [],
  }))
  return data
}

async function startDisplayCellRun(app, cellId) {
  await app.settle()
  app.components('CellView').find((entry) => entry.props.cell.id === cellId).props.onRun(cellId)
  app.flush()
  const stream = executionStream()
  app.requests('execute').at(-1).resolve(stream.response)
  await app.settle()
  return {
    emit(event) { stream.emit({ cell_id: cellId, ...event }) },
    async send(event) { stream.emit({ cell_id: cellId, ...event }); await app.settle() },
    async finish(count = 1) {
      stream.emit({ type: 'execute_reply', cell_id: cellId, ok: true, execution_count: count })
      stream.end()
      await app.settle()
    },
    end() { stream.end() },
  }
}

const sharedDisplay = (text = 'OLD', type = 'display_data', displayId = 'shared') => ({
  type, display_id: displayId, data: { 'text/plain': text }, metadata: {},
})
const displayCells = (app) => app.components('CellView').map((entry) => entry.props.cell)

test('cross-cell display updates replace every live matching slot in event order and save the updated data', async (t) => {
  const app = mountNotebook(t, { customData: displayNotebookData() })
  const first = await startDisplayCellRun(app, 'cell-1')
  await first.send(sharedDisplay())
  await first.send(sharedDisplay())
  await first.send(sharedDisplay('UNRELATED', 'display_data', 'other'))
  await first.finish(1)
  const second = await startDisplayCellRun(app, 'cell-2')
  await second.send(sharedDisplay())
  await second.finish(2)
  const third = await startDisplayCellRun(app, 'cell-3')
  third.emit(sharedDisplay('IGNORED', 'update_display_data', 'missing'))
  third.emit(sharedDisplay('ACTIVE'))
  third.emit(sharedDisplay('NEW', 'update_display_data'))
  third.emit(sharedDisplay('LATEST', 'update_display_data'))
  third.emit({ type: 'execute_reply', ok: true, execution_count: 3 })
  third.end()
  await settleWithoutCommit()
  app.flush()
  const cells = displayCells(app)
  assert.deepEqual(cells.map((cell) => cell.execution_count), [1, 2, 3], 'updating another cell does not change its execution count')
  assert.deepEqual(cells.map((cell) => [...cell.outputs].map((output) => output.data['text/plain'])), [
    ['LATEST', 'LATEST', 'UNRELATED'], ['LATEST'], ['LATEST'],
  ])
  assert.equal(app.toolbar.dirty, true)
  const save = app.save()
  assert.deepEqual(save.body.notebook.cells.map((cell) => cell.outputs.map((output) => output.data['text/plain'])), [
    ['LATEST', 'LATEST', 'UNRELATED'], ['LATEST'], ['LATEST'],
  ])
  assert.ok(save.body.notebook.cells.every((cell) => cell.outputs.every((output) => !Object.hasOwn(output, 'display_id'))))
  save.resolve(response({ ok: true, value: { version: 'v2' } }))
  await app.settle()
})

test('cross-cell display updates enforce each cell budget independently and cannot revive truncated displays', async (t) => {
  const app = mountNotebook(t, { customData: displayNotebookData() })
  const first = await startDisplayCellRun(app, 'cell-1')
  await first.send(sharedDisplay())
  await first.send(sharedDisplay())
  await first.finish()
  const second = await startDisplayCellRun(app, 'cell-2')
  await second.send(sharedDisplay())
  await second.finish()
  const third = await startDisplayCellRun(app, 'cell-3')
  await third.send(sharedDisplay('x'.repeat(17 * MiB), 'update_display_data'))
  const marker = assertOutputLimit(app)
  let cells = displayCells(app)
  assert.equal(cells[1].outputs[0].data['text/plain'].length, 17 * MiB, 'one slot fits while two slots exceed the other cell budget')
  assert.ok(outputBytes(cells[1].outputs) < OUTPUT_CAP_BYTES)
  assert.equal(cells[2].outputs.length, 0, 'an update adds no slot to the cell that emitted it')
  await third.send(sharedDisplay('SMALL', 'update_display_data'))
  await third.send({ type: 'stream', text: 'ACTIVE OUTPUT' })
  cells = displayCells(app)
  assert.equal(JSON.stringify(cells[0].outputs), marker, 'a later smaller update does not bypass truncation')
  assert.equal(cells[1].outputs[0].data['text/plain'], 'SMALL')
  assert.equal(cells[2].outputs[0].text, 'ACTIVE OUTPUT')
  await third.finish()
})

test('cross-cell display updates consume matching deferred clears but leave unrelated cells pending', async (t) => {
  const app = mountNotebook(t, { customData: displayNotebookData() })
  const first = await startDisplayCellRun(app, 'cell-1')
  await first.send(sharedDisplay())
  await first.send({ type: 'clear_output', wait: true })
  await first.finish()
  const second = await startDisplayCellRun(app, 'cell-2')
  await second.send(sharedDisplay('OTHER', 'display_data', 'other'))
  await second.send({ type: 'clear_output', wait: true })
  await second.finish()
  const third = await startDisplayCellRun(app, 'cell-3')
  third.emit({ type: 'stream', text: 'ACTIVE' })
  third.emit({ type: 'clear_output', wait: true })
  third.emit(sharedDisplay('UPDATE', 'update_display_data'))
  await settleWithoutCommit()
  app.flush()
  let cells = displayCells(app)
  assert.equal(cells[0].outputs.length, 0, 'the matching display consumes its pending clear')
  assert.equal(cells[1].outputs[0].data['text/plain'], 'OTHER', 'an unrelated update leaves this deferred clear untouched')
  assert.equal(cells[2].outputs.length, 0, 'the active cell consumes its pending clear even without a matching slot')
  await third.send(sharedDisplay('UPDATE OTHER', 'update_display_data', 'other'))
  cells = displayCells(app)
  assert.equal(cells[1].outputs.length, 0, 'the untouched pending clear is consumed by its own matching update')
  await third.finish()
})

for (const editDuringRun of [false, true]) {
  test(`an incomplete cross-cell display update restores previous outputs and preserves user edits=${editDuringRun}`, async (t) => {
    const app = mountNotebook(t, { customData: displayNotebookData() })
    for (const cellId of ['cell-1', 'cell-2']) {
      const seed = await startDisplayCellRun(app, cellId)
      await seed.send(sharedDisplay())
      await seed.finish()
    }
    app.save().resolve(response({ ok: true, value: { version: 'v2' } }))
    await app.settle()
    assert.equal(app.toolbar.dirty, false)
    const third = await startDisplayCellRun(app, 'cell-3')
    third.emit(sharedDisplay('NEW', 'update_display_data'))
    third.emit(sharedDisplay('NEWER', 'update_display_data'))
    await settleWithoutCommit()
    app.flush()
    assert.equal(displayCells(app)[0].outputs[0].data['text/plain'], 'NEWER')
    if (editDuringRun) {
      app.edit('USER EDIT')
      app.cell.onClearOutputs('cell-2')
      app.flush()
    }
    third.end()
    await app.settle()
    const cells = displayCells(app)
    assert.equal(cells[0].outputs[0].data['text/plain'], 'OLD', 'all updates from the incomplete run are rolled back')
    if (editDuringRun) {
      assert.equal(cells[0].source, 'USER EDIT')
      assert.equal(cells[1].outputs.length, 0, 'rollback does not undo a manual clear')
    } else {
      assert.equal(cells[1].outputs[0].data['text/plain'], 'OLD')
    }
    assert.equal(app.toolbar.dirty, editDuringRun)
  })
}

test('a stale cross-cell display update cannot change newly created displays after reload', async (t) => {
  const app = mountNotebook(t, { customData: displayNotebookData() })
  const first = await startDisplayCellRun(app, 'cell-1')
  await first.send(sharedDisplay())
  await first.finish()
  const old = await startDisplayCellRun(app, 'cell-2')
  await app.reload(displayNotebookData())
  const fresh = await startDisplayCellRun(app, 'cell-1')
  await fresh.send(sharedDisplay('NEW DOCUMENT'))
  old.emit(sharedDisplay('STALE', 'update_display_data'))
  old.end()
  await app.settle()
  assert.equal(displayCells(app)[0].outputs[0].data['text/plain'], 'NEW DOCUMENT')
  await fresh.finish()
})
