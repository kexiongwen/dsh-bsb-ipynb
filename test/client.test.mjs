import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))
let loadCount = 0

async function loadClient(reactOverrides = {}) {
  let options = null
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        options = value
      },
    },
  }
  const styles = []
  globalThis.document = {
    getElementById() {
      return null
    },
    createElement() {
      return { dataset: {}, style: {}, textContent: '', remove() {} }
    },
    head: {
      appendChild(element) {
        styles.push(element)
      },
    },
  }
  const react = {
    createElement(type, props, ...children) {
      return { type, props: { ...props, children } }
    },
    Fragment: 'fragment',
    useState() {},
    useEffect() {},
    useMemo() {},
    useRef() {},
    useCallback() {},
    ...reactOverrides,
  }
  await import(pathToFileURL(clientPath).href + '?test=' + Date.now() + '-' + (++loadCount))
  assert.ok(options, 'client artifact registers a module')
  assert.equal(options.id, 'dsh-bsb-ipynb')
  const exports = options.factory((id) => {
    if (id === 'react') return react
    throw new Error('unexpected module: ' + id)
  })
  return { exports, styles }
}

test('registers a custom ipynb file viewer through betterSidebar', async () => {
  const { exports, styles } = await loadClient()
  const viewers = []
  const ctx = {
    effect(effect) {
      return effect()
    },
    betterSidebar: {
      hostRouteUrl(path) {
        return 'http://127.0.0.1:61099/' + path
      },
      registerFileViewer(descriptor) {
        viewers.push(descriptor)
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  assert.equal(viewers.length, 1)
  const viewer = viewers[0]
  assert.equal(viewer.id, 'dsh-bsb-ipynb:notebook')
  assert.deepEqual(viewer.exts, ['ipynb'])
  assert.equal(viewer.priority, 10)
  assert.equal(viewer.fetchStrategy, 'custom')
  assert.equal(typeof viewer.load, 'function')
  assert.equal(typeof viewer.component, 'function')
  assert.equal(styles.length, 1)
  assert.equal(styles[0].id, 'dsh-bsb-ipynb-styles')
  assert.match(styles[0].textContent, /\.dsh-bsb-ipynb-root/)
})

test('load posts the session and path to the host route', async () => {
  const { exports } = await loadClient()
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, value: { status: 'ok', notebook: { cells: [] }, version: 'a'.repeat(64) } }
      },
    }
  }
  try {
    const viewer = exports.__test
    assert.ok(viewer)
    const load = exports.apply
    const ctx = {
      effect(effect) {
        return effect()
      },
      betterSidebar: {
        hostRouteUrl(path) {
          return 'http://host/' + path
        },
        registerFileViewer(descriptor) {
          ctx.viewer = descriptor
          return () => {}
        },
      },
    }
    load(ctx)
    const value = await ctx.viewer.load('/workspace/demo.ipynb', { sessionId: 'session-1' })
    assert.equal(value.status, 'ok')
    assert.equal(calls[0].url, 'http://host/ipynb/read')
    const body = JSON.parse(calls[0].init.body)
    assert.deepEqual(body, { sessionId: 'session-1', path: '/workspace/demo.ipynb' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('load converts host failures into an error payload instead of throwing', async () => {
  const { exports } = await loadClient()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    async json() {
      return { ok: false, error: { code: 'path-outside-root', message: 'outside' } }
    },
  })
  try {
    const ctx = {
      effect(effect) {
        return effect()
      },
      betterSidebar: {
        hostRouteUrl(path) {
          return 'http://host/' + path
        },
        registerFileViewer(descriptor) {
          ctx.viewer = descriptor
          return () => {}
        },
      },
    }
    exports.apply(ctx)
    const value = await ctx.viewer.load('/etc/passwd', { sessionId: 's1' })
    assert.deepEqual(value, { status: 'error', code: 'path-outside-root', message: 'outside' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('markdown renders common constructs and escapes raw HTML', async () => {
  const { exports } = await loadClient()
  const { renderMarkdown } = exports.__test
  const html = renderMarkdown('# Title\n\n**bold** and *italic* and `code`\n\n<script>alert(1)</script>\n\n```python\nprint("<x>")\n```')
  assert.match(html, /<h1>Title<\/h1>/)
  assert.match(html, /<strong>bold<\/strong>/)
  assert.match(html, /<em>italic<\/em>/)
  assert.match(html, /<code>code<\/code>/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /class="dsh-bsb-ipynb-md-code"/)
  assert.match(html, /&lt;x&gt;/)
})

test('markdown refuses javascript links and keeps relative images', async () => {
  const { exports } = await loadClient()
  const { renderMarkdown, sanitizeUrl } = exports.__test
  const html = renderMarkdown('[click](javascript:alert(1)) ![alt](pic.png)')
  assert.doesNotMatch(html, /href="javascript:/)
  assert.match(html, /<img src="pic\.png"/)
  assert.equal(sanitizeUrl('javascript:alert(1)'), null)
  assert.equal(sanitizeUrl('https://example.com/a'), 'https://example.com/a')
  assert.equal(sanitizeUrl('data:image/png;base64,aaaa', { image: true }), 'data:image/png;base64,aaaa')
  assert.equal(sanitizeUrl('data:text/html;base64,aaaa', { image: true }), null)
})

test('markdown image resolver rewrites local images and resolves attachments', async () => {
  const { exports } = await loadClient()
  const { renderMarkdownWithImages } = exports.__test
  const html = renderMarkdownWithImages('![plot](img/plot.png)', () => '/sidebar/file?path=%2Fws%2Fimg%2Fplot.png')
  assert.match(html, /src="\/sidebar\/file\?path=%2Fws%2Fimg%2Fplot\.png"/)
})

test('html sanitizer falls back to escaping when DOMParser is unavailable', async () => {
  const { exports } = await loadClient()
  const { sanitizeHtml } = exports.__test
  const html = sanitizeHtml('<b>x</b><script>alert(1)</script>')
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;b&gt;/)
})

test('ansi output keeps colors and strips other control sequences', async () => {
  const { exports } = await loadClient()
  const { ansiToHtml } = exports.__test
  const html = ansiToHtml('\u001b[31mred\u001b[0m plain\u001b[2K')
  assert.match(html, /<span style="color:#cd3131">red<\/span>/)
  assert.match(html, / plain/)
  assert.doesNotMatch(html, /\u001b/)
})

test('python highlighting marks keywords, strings and comments', async () => {
  const { exports } = await loadClient()
  const { highlightPython } = exports.__test
  const html = highlightPython('def f():\n    return "x"  # note')
  assert.match(html, /dsh-bsb-ipynb-tok-keyword">def</)
  assert.match(html, /dsh-bsb-ipynb-tok-keyword">return</)
  assert.match(html, /dsh-bsb-ipynb-tok-string">&quot;x&quot;<\/span>/)
  assert.match(html, /dsh-bsb-ipynb-tok-comment"># note</)
})

test('sanitizeUrl strips control characters before the scheme check', async () => {
  const { exports } = await loadClient()
  const { sanitizeUrl } = exports.__test
  assert.equal(sanitizeUrl('java\nscript:alert(1)'), null)
  assert.equal(sanitizeUrl('java\tscript:alert(1)'), null)
  assert.equal(sanitizeUrl('java\rscript:alert(1)'), null)
  assert.equal(sanitizeUrl('\u0000javascript:alert(1)'), null)
  assert.equal(sanitizeUrl('  https://example.com/a\n'), 'https://example.com/a')
})

test('sanitizer allowlist does not permit inline style attributes', async () => {
  const { exports } = await loadClient()
  assert.equal(exports.__test.ALLOWED_ATTRS.has('style'), false)
  assert.equal(exports.__test.ALLOWED_ATTRS.has('onclick'), false)
})

test('array text MIME values join without separators', async () => {
  const { exports } = await loadClient()
  const { mimeText } = exports.__test
  assert.equal(mimeText(['line one\n', 'line two']), 'line one\nline two')
  assert.equal(mimeText('plain'), 'plain')
  assert.equal(mimeText(null), '')
})

test('notebook normalization and serialization round-trip source lines', async () => {
  const { exports } = await loadClient()
  const { normalizeNotebook, serializeNotebook, emptyNotebook } = exports.__test
  const notebook = normalizeNotebook({
    cells: [{ cell_type: 'code', source: ['a = 1\n', 'a + 1'], outputs: [], execution_count: 2 }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 4,
  })
  assert.equal(notebook.cells[0].source, 'a = 1\na + 1')
  assert.ok(notebook.cells[0].id)
  const serialized = serializeNotebook(notebook)
  const parsed = JSON.parse(serialized)
  assert.equal(parsed.nbformat, 4)
  assert.equal(parsed.nbformat_minor, 5)
  assert.deepEqual(parsed.cells[0].source, ['a = 1\n', 'a + 1'])
  const empty = JSON.parse(serializeNotebook(emptyNotebook()))
  assert.deepEqual(empty.cells[0].source, [])
  assert.equal(empty.cells[0].cell_type, 'code')
})

test('notebook normalization removes nbformat-illegal output fields', async () => {
  const { exports } = await loadClient()
  const { normalizeNotebook } = exports.__test
  const notebook = normalizeNotebook({
    cells: [{
      cell_type: 'code',
      source: '',
      execution_count: null,
      outputs: [
        { output_type: 'display_data', data: { 'text/plain': 'x' }, metadata: {}, execution_count: null, display_id: 'd1' },
        { output_type: 'execute_result', data: { 'text/plain': '2' }, metadata: {}, execution_count: 2, display_id: 'd2' },
      ],
    }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })
  const outputs = notebook.cells[0].outputs
  assert.equal('execution_count' in outputs[0], false)
  assert.equal('display_id' in outputs[0], false)
  assert.equal(outputs[1].execution_count, 2)
  assert.equal('display_id' in outputs[1], false)
})

test('serialization strips display_id and illegal execution_count from outputs', async () => {
  const { exports } = await loadClient()
  const { serializeNotebook } = exports.__test
  const parsed = JSON.parse(serializeNotebook({
    cells: [{
      cell_type: 'code',
      source: '',
      execution_count: 1,
      outputs: [
        { output_type: 'display_data', data: {}, metadata: {}, execution_count: 7, display_id: 'd1' },
        { output_type: 'execute_result', data: { 'text/plain': '2' }, metadata: {}, execution_count: 3, display_id: 'd2' },
        { output_type: 'stream', name: 'stdout', text: 'hi', execution_count: 4 },
        { output_type: 'error', ename: 'E', evalue: 'v', traceback: [], display_id: 'd3' },
      ],
    }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }))
  const outputs = parsed.cells[0].outputs
  assert.equal('execution_count' in outputs[0], false)
  assert.equal('display_id' in outputs[0], false)
  assert.equal(outputs[1].execution_count, 3)
  assert.equal('display_id' in outputs[1], false)
  assert.equal('execution_count' in outputs[2], false)
  assert.equal('display_id' in outputs[3], false)
  // The original invalid input must not be mutated by serialization.
  assert.equal('display_id' in outputs[2], false)
})

test('the save preflight measures the same serialized size the server caps', async () => {
  const { exports } = await loadClient()
  const { notebookCapacity, serializeNotebook, normalizeNotebook, NOTEBOOK_CAP_BYTES, capacityText } = exports.__test
  assert.equal(NOTEBOOK_CAP_BYTES, 32 * 1024 * 1024)
  assert.deepEqual(notebookCapacity(null), { ok: true, bytes: 0 })
  const notebook = normalizeNotebook({
    cells: [{
      cell_type: 'code',
      source: 'print(1)',
      execution_count: 1,
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'hello' }],
    }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })
  const exact = Buffer.byteLength(serializeNotebook(notebook), 'utf8')
  assert.deepEqual(notebookCapacity(notebook), { ok: true, bytes: exact })
  assert.equal(notebookCapacity(notebook, exact).ok, true, 'the exact limit is still saveable')
  assert.equal(notebookCapacity(notebook, exact - 1).ok, false, 'one byte above the limit is blocked')
  assert.match(capacityText(exact), /32 MiB/)
  assert.match(capacityText(exact), new RegExp((exact / 1048576).toFixed(1)))
})

test('autosave recovers after a failed save only when the notebook changes', async () => {
  const { exports } = await loadClient()
  const { shouldScheduleAutosave } = exports.__test
  const failed = {
    loadStatus: 'ok',
    dirty: true,
    conflict: null,
    autosaveBlocked: false,
    runningCell: null,
    saveState: 'failed',
    notebookChangedSinceFailure: true,
  }
  assert.equal(shouldScheduleAutosave(failed), true)
  // Same snapshot that failed: wait for an edit instead of retrying in a loop.
  assert.equal(shouldScheduleAutosave({ ...failed, notebookChangedSinceFailure: false }), false)
  // Once a save has succeeded (saveState !== 'failed') a still-dirty edit must
  // be autosaved again, changedSinceFailure no longer matters.
  assert.equal(shouldScheduleAutosave({ ...failed, saveState: 'saved', notebookChangedSinceFailure: false }), true)
})

test('autosave stays blocked by conflict, running cell or clean state', async () => {
  const { exports } = await loadClient()
  const { shouldScheduleAutosave } = exports.__test
  const base = { loadStatus: 'ok', dirty: true, conflict: null, autosaveBlocked: false, runningCell: null, saveState: 'idle', notebookChangedSinceFailure: true }
  assert.equal(shouldScheduleAutosave(base), true)
  assert.equal(shouldScheduleAutosave({ ...base, conflict: 'v2' }), false)
  assert.equal(shouldScheduleAutosave({ ...base, autosaveBlocked: true }), false)
  assert.equal(shouldScheduleAutosave({ ...base, capacityBlocked: true }), false)
  assert.equal(shouldScheduleAutosave({ ...base, runningCell: 'c1' }), false)
  assert.equal(shouldScheduleAutosave({ ...base, saveState: 'saving' }), false)
  assert.equal(shouldScheduleAutosave({ ...base, dirty: false }), false)
  assert.equal(shouldScheduleAutosave({ ...base, loadStatus: 'loading' }), false)
})

test('execute_reply with ok:false is treated as a failed run', async () => {
  const { exports } = await loadClient()
  const { executeReplyFailed } = exports.__test
  assert.equal(executeReplyFailed({ type: 'execute_reply', ok: false, status: 'error' }), true)
  assert.equal(executeReplyFailed({ type: 'execute_reply', ok: true, status: 'ok' }), false)
  assert.equal(executeReplyFailed({ type: 'stream', ok: false }), false)
  assert.equal(executeReplyFailed(null), false)
})

test('save button is disabled while a write conflict is unresolved', async () => {
  const { exports } = await loadClient()
  const { saveButtonDisabled } = exports.__test
  assert.equal(saveButtonDisabled({ dirty: true, saveState: 'idle', conflict: null }), false)
  assert.equal(saveButtonDisabled({ dirty: true, saveState: 'idle', conflict: 'v2' }), true)
  assert.equal(saveButtonDisabled({ dirty: false, saveState: 'idle', conflict: null }), true)
  assert.equal(saveButtonDisabled({ dirty: true, saveState: 'saving', conflict: null }), true)
})

test('restart only forwards a real interpreter path string', async () => {
  const { exports } = await loadClient()
  const { resolveRestartPython } = exports.__test
  assert.equal(resolveRestartPython({ type: 'click' }, '/usr/bin/python3'), '/usr/bin/python3')
  assert.equal(resolveRestartPython(undefined, '/usr/bin/python3'), '/usr/bin/python3')
  assert.equal(resolveRestartPython('', '/usr/bin/python3'), '/usr/bin/python3')
  assert.equal(resolveRestartPython('/usr/bin/python3.12', '/usr/bin/python3'), '/usr/bin/python3.12')
  assert.equal(resolveRestartPython({ type: 'click' }, ''), undefined)
})

test('stale save responses are detected', async () => {
  const { exports } = await loadClient()
  const { isStaleSaveResponse } = exports.__test
  assert.equal(isStaleSaveResponse(2, 1), true)
  assert.equal(isStaleSaveResponse(1, 1), false)
})

test('runs without execute_reply restore pre-run outputs', async () => {
  const { exports } = await loadClient()
  const { shouldRestoreOutputsAfterRun } = exports.__test
  // fatal / kernel_died / truncated stream / abort paths never see a reply.
  assert.equal(shouldRestoreOutputsAfterRun(false), true)
  // execute_reply ok:false still has real error output, so keep it.
  assert.equal(shouldRestoreOutputsAfterRun(true), false)
})

test('truncation banner string exists in both languages', async () => {
  const { exports } = await loadClient()
  const { STRINGS } = exports.__test
  assert.equal(typeof STRINGS.en.outputTruncated, 'string')
  assert.equal(typeof STRINGS.zh.outputTruncated, 'string')
  assert.ok(STRINGS.en.outputTruncated.length > 0)
  assert.ok(STRINGS.zh.outputTruncated.length > 0)
})

test('notebook normalization replaces duplicate and illegal cell ids', async () => {
  const { exports } = await loadClient()
  const notebook = exports.__test.normalizeNotebook({
    cells: [
      { id: 'keep-me', cell_type: 'markdown', source: '' },
      { id: 'keep-me', cell_type: 'markdown', source: '' },
      { id: 'has space', cell_type: 'markdown', source: '' },
      { id: 'a'.repeat(65), cell_type: 'markdown', source: '' },
      { id: '', cell_type: 'markdown', source: '' },
      { id: 123, cell_type: 'markdown', source: '' },
    ],
  })
  const ids = notebook.cells.map((cell) => cell.id)
  assert.equal(ids[0], 'keep-me')
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.match(id, /^[a-zA-Z0-9_-]{1,64}$/)
})

test('cell events keep global events and reject mismatched cell ids', async () => {
  const { exports } = await loadClient()
  const { shouldHandleCellEvent } = exports.__test
  assert.equal(shouldHandleCellEvent('cell-1', { cell_id: 'cell-1' }), true)
  assert.equal(shouldHandleCellEvent('cell-1', { cell_id: 'cell-2' }), false)
  assert.equal(shouldHandleCellEvent('cell-1', {}), true)
  assert.equal(shouldHandleCellEvent('cell-1', { cell_id: null }), true)
  assert.equal(shouldHandleCellEvent('cell-1', { cell_id: '' }), true)
})

test('cell edit action uses editCell and doneEditing text', async () => {
  const { exports } = await loadClient()
  const { CellView, STRINGS } = exports.__test
  const strings = /^zh/i.test(globalThis.navigator?.language || '') ? STRINGS.zh : STRINGS.en
  const render = (editing) => CellView({
    cell: { id: 'cell-1', cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: '' },
    index: 0,
    count: 1,
    editing,
    running: false,
  })
  const findByTitle = (root, title) => {
    const pending = [root]
    while (pending.length) {
      const node = pending.pop()
      if (!node || typeof node !== 'object') continue
      if (Array.isArray(node)) {
        pending.push(...node)
        continue
      }
      const props = node.props || {}
      if (props.title === title) return node
      pending.push(...(props.children || []))
    }
    return null
  }
  const edit = findByTitle(render(false), strings.editCell)
  const done = findByTitle(render(true), strings.doneEditing)
  assert.ok(edit)
  assert.ok(done)
  assert.deepEqual(edit.props.children, [strings.editCell])
  assert.deepEqual(done.props.children, [strings.doneEditing])
})

test('cell type changes detect actual output and attachment loss', async () => {
  const { exports } = await loadClient()
  const { cellTypeChangeLosesData } = exports.__test
  const output = { output_type: 'stream', name: 'stdout', text: 'result' }
  assert.equal(cellTypeChangeLosesData({ cell_type: 'code', outputs: [output] }, 'markdown'), true)
  assert.equal(cellTypeChangeLosesData({ cell_type: 'code', outputs: [output] }, 'raw'), true)
  assert.equal(cellTypeChangeLosesData({ cell_type: 'code', outputs: [output] }, 'code'), false)
  assert.equal(cellTypeChangeLosesData({ cell_type: 'code', outputs: [] }, 'markdown'), false)
  assert.equal(cellTypeChangeLosesData({ cell_type: 'markdown', attachments: { 'plot.png': {} } }, 'raw'), true)
  assert.equal(cellTypeChangeLosesData({ cell_type: 'markdown', attachments: { 'plot.png': {} } }, 'code'), true)
  assert.equal(cellTypeChangeLosesData({ cell_type: 'raw', attachments: { 'plot.png': {} } }, 'markdown'), false)
  assert.equal(cellTypeChangeLosesData({ cell_type: 'markdown', attachments: {} }, 'raw'), false)
})

test('cell deletion and type changes honor confirmation and cancellation', async () => {
  const stateCalls = []
  let stateIndex = 0
  const { exports } = await loadClient({
    useState(initial) {
      const index = stateIndex++
      return [initial, (value) => stateCalls.push({ index, value })]
    },
    useRef(value) {
      return { current: value }
    },
    useCallback(callback) {
      return callback
    },
  })
  const { NotebookView, CellView, STRINGS } = exports.__test
  const tree = NotebookView({
    ctx: {},
    scope: {},
    path: '/workspace/demo.ipynb',
    visible: false,
    customData: {
      status: 'ok',
      version: 'v1',
      notebook: {
        cells: [
          { id: 'with-output', cell_type: 'code', execution_count: 1, metadata: {}, outputs: [{ output_type: 'stream', name: 'stdout', text: 'result' }], source: '' },
          { id: 'empty', cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: '' },
        ],
      },
    },
  })
  const views = {}
  const pending = [tree]
  while (pending.length) {
    const node = pending.pop()
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      pending.push(...node)
      continue
    }
    if (node.type === CellView) views[node.props.cell.id] = node.props
    pending.push(...((node.props && node.props.children) || []))
  }
  const messages = []
  globalThis.window.confirm = (message) => {
    messages.push(message)
    return false
  }
  views['with-output'].onDelete('with-output')
  views['with-output'].onType('with-output', 'markdown')
  assert.equal(stateCalls.length, 0, 'cancelled operations must not update notebook or dirty state')
  views.empty.onType('empty', 'markdown')
  assert.equal(messages.length, 2, 'a lossless type change must not ask for confirmation')
  assert.equal(stateCalls.length, 2, 'a lossless type change still updates notebook and dirty state')
  const strings = /^zh/i.test(globalThis.navigator?.language || '') ? STRINGS.zh : STRINGS.en
  assert.deepEqual(messages, [strings.deleteCellConfirm, strings.changeTypeConfirm])
})

test('kernel restart replies have a clear bilingual warning', async () => {
  const { exports } = await loadClient()
  const { kernelRestartedReply, STRINGS } = exports.__test
  assert.equal(kernelRestartedReply({ type: 'execute_reply', kernel_restarted: true }), true)
  assert.equal(kernelRestartedReply({ type: 'execute_reply', kernel_restarted: false }), false)
  assert.equal(kernelRestartedReply({ type: 'execute_reply' }), false)
  assert.equal(kernelRestartedReply({ type: 'stream', kernel_restarted: true }), false)
  assert.match(STRINGS.en.kernelRestarted, /Interrupt timed out/)
  assert.match(STRINGS.en.kernelRestarted, /variables and kernel state have been cleared/)
  assert.match(STRINGS.zh.kernelRestarted, /中断超时/)
  assert.match(STRINGS.zh.kernelRestarted, /变量和内核状态均已清空/)
})

function assertOutputBytes(outputsSize, outputs, label = 'output JSON bytes') {
  assert.equal(outputsSize(outputs), Buffer.byteLength(JSON.stringify(outputs), 'utf8'), label)
}

function freezeOutputFixture(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeOutputFixture)
    Object.freeze(value)
  }
  return value
}

async function loadOutputReducer() {
  const { exports } = await loadClient()
  const api = exports.__test
  assert.equal(typeof api.reduceOutputs, 'function')
  assert.equal(typeof api.outputsSize, 'function')
  assert.equal(api.MAX_CELL_OUTPUT_BYTES, 32 * 1024 * 1024)
  return api
}

test('output byte accounting includes JSON structure, escaping, metadata and error details', async () => {
  const { outputsSize } = await loadOutputReducer()
  const outputs = freezeOutputFixture([
    { output_type: 'stream', name: 'stdout', text: 'ASCII 中文 😀 " \\ \n\r\t\b\f\u0000 \ud800 \udc00' },
    {
      output_type: 'display_data', display_id: '显示-1',
      data: {
        'text/plain': ['第一行\n', 'emoji 😀'],
        'application/json': { nested: ['"', '\\', true, false, null, 1.25, -7], '键\n': '值' },
      },
      metadata: { width: 640, caption: '"图"\n\ud800', nested: { controls: '\u0001\u001f' } },
    },
    { output_type: 'error', ename: '错误', evalue: 'bad "value" 😀', traceback: ['line\n1', '\\line\t2\udc00'] },
    { output_type: 'execute_result', execution_count: 12, data: { 'text/plain': '42' }, metadata: {} },
  ])
  assertOutputBytes(outputsSize, [])
  for (let length = 1; length <= outputs.length; length += 1) {
    assertOutputBytes(outputsSize, outputs.slice(0, length))
  }
  assertOutputBytes(outputsSize, outputs)
  assertOutputBytes(outputsSize, outputs, 're-reading a frozen snapshot must not increment its accounting')
})

test('stream merging matches UTF-8 JSON bytes for Unicode, escaping and split surrogate pairs', async () => {
  const { reduceOutputs, outputsSize } = await loadOutputReducer()
  const cases = [
    ['ASCII', ' text'],
    ['中', '文', '😀'],
    ['"', '\\', '\n', '\r\t\b\f\u0000\u001f'],
    ['\ud83d', '\ude00'],
    ['prefix\ud83d', '\ude00suffix'],
    ['\ud800', 'x'],
    ['\udc00', '\ud800'],
    ['\ud83d', '\ude00', '\ud83d', '\ude00'],
    ['"\ud83d', '\ude00\\', '\ud800'],
  ]
  for (const chunks of cases) {
    let outputs = []
    let text = ''
    for (const chunk of chunks) {
      text += chunk
      outputs = reduceOutputs(outputs, { type: 'stream', name: 'stdout', text: chunk })
      assert.equal(outputs.length, 1)
      assert.equal(outputs[0].text, text)
      assertOutputBytes(outputsSize, outputs, 'bytes after chunk ' + JSON.stringify(chunk))
    }
  }
})

test('only adjacent streams with the same name merge and every event keeps exact accounting', async () => {
  const { reduceOutputs, outputsSize } = await loadOutputReducer()
  let outputs = []
  for (const event of [
    { type: 'stream', name: 'stdout', text: 'one' },
    { type: 'stream', name: 'stdout', text: '中文' },
    { type: 'stream', name: 'stderr', text: 'error\n' },
    { type: 'stream', name: 'stdout', text: 'three' },
    { type: 'stream', name: 'stdout', text: '😀' },
  ]) {
    outputs = reduceOutputs(outputs, event)
    assertOutputBytes(outputsSize, outputs)
  }
  assert.deepEqual(outputs.map(({ name, text }) => ({ name, text })), [
    { name: 'stdout', text: 'one中文' },
    { name: 'stderr', text: 'error\n' },
    { name: 'stdout', text: 'three😀' },
  ])
})

test('display updates account for every matching slot and subtract replaced data and metadata', async () => {
  const { reduceOutputs, outputsSize } = await loadOutputReducer()
  let outputs = []
  for (const event of [
    { type: 'display_data', display_id: 'shared', data: { 'text/plain': 'first' }, metadata: { old: 'large'.repeat(20) } },
    { type: 'display_data', display_id: 'other', data: { 'text/plain': 'untouched' }, metadata: { keep: true } },
    { type: 'execute_result', display_id: 'shared', execution_count: 7, data: { 'text/plain': 'second' }, metadata: { old: 'different' } },
  ]) {
    outputs = reduceOutputs(outputs, event)
    assertOutputBytes(outputsSize, outputs)
  }
  const before = freezeOutputFixture(outputs)
  const update = freezeOutputFixture({
    type: 'update_display_data', display_id: 'shared',
    data: { 'text/plain': '中文😀'.repeat(30), 'application/json': { quotes: '"\\\n', lone: '\ud800' } },
    metadata: { nested: { caption: '新值\n', values: [1, null, true] } },
  })
  const updated = reduceOutputs(before, update)
  assert.deepEqual(updated[0].data, update.data)
  assert.deepEqual(updated[2].data, update.data)
  assert.deepEqual(updated[0].metadata, update.metadata)
  assert.deepEqual(updated[2].metadata, update.metadata)
  assert.deepEqual(updated[1], before[1])
  assert.equal(updated[2].execution_count, 7)
  assert.equal(before[0].data['text/plain'], 'first', 'updating displays must not mutate the previous snapshot')
  assertOutputBytes(outputsSize, updated)
  const repeated = reduceOutputs(before, update)
  assert.deepEqual(repeated, updated)
  assertOutputBytes(outputsSize, repeated, 'replayed display updates must not charge their bytes twice')
  const shrunk = reduceOutputs(updated, { type: 'update_display_data', display_id: 'shared', data: {}, metadata: {} })
  assert.ok(outputsSize(shrunk) < outputsSize(updated))
  assertOutputBytes(outputsSize, shrunk)
  const unmatched = reduceOutputs(shrunk, { type: 'update_display_data', display_id: 'missing', data: update.data, metadata: update.metadata })
  assert.deepEqual(unmatched, shrunk)
  assertOutputBytes(outputsSize, unmatched, 'unknown display IDs do not consume retained-output budget')
})

test('replaying an output reducer never mutates the input or accumulates charges', async () => {
  const { reduceOutputs, outputsSize } = await loadOutputReducer()
  const initial = freezeOutputFixture([{ output_type: 'stream', name: 'stdout', text: 'prefix\ud83d' }])
  const original = JSON.stringify(initial)
  for (const event of [
    { type: 'stream', name: 'stdout', text: '\ude00suffix' },
    { type: 'display_data', display_id: 'new', data: { 'text/plain': '展示' }, metadata: { key: 'value' } },
    { type: 'execute_result', execution_count: 2, data: { 'application/json': { answer: 42 } }, metadata: {} },
    { type: 'error', ename: 'ExampleError', evalue: '中文 "value"', traceback: ['line1\n', 'line2\\😀'] },
  ]) {
    freezeOutputFixture(event)
    const first = reduceOutputs(initial, event)
    const second = reduceOutputs(initial, event)
    assert.deepEqual(second, first)
    assert.equal(JSON.stringify(initial), original)
    assertOutputBytes(outputsSize, initial)
    assertOutputBytes(outputsSize, first)
    assertOutputBytes(outputsSize, second)
  }
})

test('pending clears are immutable replayable state and apply in output event order', async () => {
  const { reduceOutputs, outputsSize } = await loadOutputReducer()
  const baseline = freezeOutputFixture(reduceOutputs([], { type: 'stream', text: 'BEFORE', name: 'stdout' }))
  const pending = reduceOutputs(baseline, { type: 'clear_output', wait: true })
  assert.deepEqual(pending, baseline, 'wait=true keeps the existing visible output until the next output')
  assertOutputBytes(outputsSize, pending)
  const left = reduceOutputs(pending, { type: 'stream', name: 'stdout', text: 'LEFT' })
  const right = reduceOutputs(pending, { type: 'stream', name: 'stdout', text: 'RIGHT' })
  assert.equal(left[0].text, 'LEFT')
  assert.equal(right[0].text, 'RIGHT')
  assert.equal(pending[0].text, 'BEFORE')
  assert.equal(reduceOutputs(baseline, { type: 'stream', name: 'stdout', text: 'AFTER' })[0].text, 'BEFOREAFTER',
    'recording a pending clear must not mutate the original snapshot branch')
  assert.deepEqual(reduceOutputs(pending, { type: 'stream', name: 'stdout', text: 'LEFT' }), left)
  for (const outputs of [baseline, pending, left, right]) assertOutputBytes(outputsSize, outputs)

  let ordered = reduceOutputs(baseline, { type: 'stream', name: 'stdout', text: 'A' })
  ordered = reduceOutputs(ordered, { type: 'clear_output', wait: true })
  ordered = reduceOutputs(ordered, { type: 'stream', name: 'stdout', text: 'B' })
  assert.equal(ordered[0].text, 'B', 'the clear follows A and precedes B')
  const cleared = reduceOutputs(pending, { type: 'clear_output', wait: false })
  assert.deepEqual(cleared, [])
  let afterClear = reduceOutputs(cleared, { type: 'stream', name: 'stdout', text: 'A' })
  afterClear = reduceOutputs(afterClear, { type: 'stream', name: 'stdout', text: 'B' })
  assert.equal(afterClear[0].text, 'AB', 'an immediate clear also cancels an older pending clear')
  assertOutputBytes(outputsSize, cleared)
  assertOutputBytes(outputsSize, afterClear)
})

test('streams larger than the former five-million-character cap retain data within the byte budget', async () => {
  const { reduceOutputs, outputsSize, MAX_CELL_OUTPUT_BYTES } = await loadOutputReducer()
  const text = 'x'.repeat(5_000_001)
  const outputs = reduceOutputs([], { type: 'stream', name: 'stdout', text })
  assert.equal(outputs.length, 1)
  assert.equal(outputs[0].text, text)
  assertOutputBytes(outputsSize, outputs)
  assert.ok(outputsSize(outputs) < MAX_CELL_OUTPUT_BYTES)
})

test('an exact byte-limit stream accepts a split surrogate completion that reduces serialized size', async () => {
  const { reduceOutputs, outputsSize, MAX_CELL_OUTPUT_BYTES } = await loadOutputReducer()
  const overhead = Buffer.byteLength(JSON.stringify([{ output_type: 'stream', name: 'stdout', text: '' }]), 'utf8')
  const text = 'x'.repeat(MAX_CELL_OUTPUT_BYTES - overhead - 6) + '\ud83d'
  const full = reduceOutputs([], { type: 'stream', name: 'stdout', text })
  assert.equal(full[0].text, text)
  assert.equal(outputsSize(full), MAX_CELL_OUTPUT_BYTES)
  assertOutputBytes(outputsSize, full)
  const paired = reduceOutputs(full, { type: 'stream', name: 'stdout', text: '\ude00' })
  assert.equal(paired[0].text.endsWith('😀'), true)
  assert.equal(outputsSize(paired), MAX_CELL_OUTPUT_BYTES - 2,
    'two escaped lone surrogates become one four-byte UTF-8 code point, a net reduction of two bytes here')
  assertOutputBytes(outputsSize, paired)
  const exact = reduceOutputs(paired, { type: 'stream', name: 'stdout', text: 'zz' })
  assert.equal(outputsSize(exact), MAX_CELL_OUTPUT_BYTES)
  assertOutputBytes(outputsSize, exact)
  const capped = reduceOutputs(exact, { type: 'stream', name: 'stdout', text: '!' })
  assert.ok(outputsSize(capped) <= MAX_CELL_OUTPUT_BYTES)
  assertOutputBytes(outputsSize, capped)
  assert.equal(full[0].text, text, 'later merging/truncation must not modify the original full snapshot')
})
