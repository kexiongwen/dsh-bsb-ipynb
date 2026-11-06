import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))

async function loadClient() {
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
    createElement() {
      return null
    },
    Fragment: 'fragment',
    useState() {},
    useEffect() {},
    useMemo() {},
    useRef() {},
    useCallback() {},
  }
  await import(pathToFileURL(clientPath).href + '?test=' + Date.now())
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
