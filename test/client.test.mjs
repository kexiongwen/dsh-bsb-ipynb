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
