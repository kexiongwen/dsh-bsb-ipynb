import assert from 'node:assert/strict'
import { test } from 'node:test'
import { METADATA_DEPTH_LIMIT, METADATA_NODE_LIMIT, NOTEBOOK_CAP_BYTES } from '../lib/notebook.js'
import { installDomParser } from './client-dom-stub.mjs'
import { loadClient } from './client-harness.mjs'

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
  assert.equal(typeof viewer.title, 'function', 'the viewer title follows the active language')
  assert.equal(viewer.title(), 'Jupyter Notebook')
  assert.equal(typeof viewer.load, 'function')
  assert.equal(typeof viewer.component, 'function')
  assert.equal(styles.length, 1)
  assert.equal(styles[0].id, 'dsh-bsb-ipynb-styles')
  assert.match(styles[0].textContent, /\.dsh-bsb-ipynb-root/)
})

test('registers the en/zh dictionaries and follows the host locale preference', async () => {
  const { exports } = await loadClient()
  const { STRINGS, LOCALE_NS, translate } = exports.__test
  const registrations = []
  const cleanups = []
  let active = 'en'
  const locale = {
    register(ns, language, dict) {
      registrations.push({ ns, language, dict })
      return () => {}
    },
    bind(ns) {
      assert.equal(ns, LOCALE_NS)
      return (key) => STRINGS[active][key] ?? STRINGS.en[key] ?? key
    },
    subscribe() {
      return () => {}
    },
    getSnapshot() {
      return { active, revision: 1, locales: [] }
    },
  }
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['locale'])
      callback({
        locale,
        effect(effect) {
          const cleanup = effect()
          if (cleanup) cleanups.push(cleanup)
          return cleanup
        },
      })
    },
    effect(effect) {
      return effect()
    },
    betterSidebar: {
      hostRouteUrl: (path) => 'http://host/' + path,
      registerFileViewer: () => () => {},
    },
  }
  exports.apply(ctx)
  assert.equal(registrations.length, 2)
  assert.equal(registrations[0].ns, LOCALE_NS)
  assert.deepEqual(registrations.map((entry) => entry.language).sort(), ['en', 'zh'])
  const registered = {}
  for (const entry of registrations) registered[entry.language] = entry.dict
  assert.ok(registered.en && registered.zh, 'both locale dictionaries are registered')
  const enKeys = Object.keys(registered.en).sort()
  assert.deepEqual(Object.keys(registered.zh).sort(), enKeys, 'both locales expose the same string keys')
  assert.equal(enKeys.length, 60, 'the audited client dictionary exposes 60 translation keys')
  for (const key of enKeys) {
    assert.equal(typeof registered.en[key], 'string', `en.${key} must be a translated string`)
    assert.ok(registered.en[key].length > 0, `en.${key} must not be empty`)
    assert.equal(typeof registered.zh[key], 'string', `zh.${key} must be a translated string`)
    assert.ok(registered.zh[key].length > 0, `zh.${key} must not be empty`)
  }
  // Merged truncation-banner assertion: the output-truncated copy exists in both
  // languages and the loop above also proves it is non-empty.
  assert.ok(registered.en.outputTruncated.length > 0, 'the truncation banner copy exists in English')
  assert.ok(registered.zh.outputTruncated.length > 0, 'the truncation banner copy exists in Chinese')
  assert.equal(registered.en.run, 'Run')
  assert.equal(registered.zh.run, '运行')
  assert.equal(translate('run'), 'Run', 'host preference starts in English')
  active = 'zh'
  assert.equal(translate('run'), '运行', 'translate follows the active host locale')
  for (const cleanup of cleanups) cleanup()
  assert.equal(translate('run'), 'Run', 'disposal restores the browser-language fallback')
})

test('NotebookView subscribes to the locale registry for live language switches', async () => {
  const captured = {}
  const { exports } = await loadClient({
    useState(initial) {
      return [initial, () => {}]
    },
    useRef(value) {
      return { current: value }
    },
    useMemo(factory) {
      return factory()
    },
    useCallback(callback) {
      return callback
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      captured.subscribe = subscribe
      captured.getSnapshot = getSnapshot
      return getSnapshot()
    },
  })
  const listeners = new Set()
  let revision = 1
  const locale = {
    register() {
      return () => {}
    },
    bind() {
      return (key) => key
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot() {
      return { active: 'en', revision, locales: [] }
    },
  }
  const ctx = {
    get(name) {
      return name === 'locale' ? locale : undefined
    },
    inject(names, callback) {
      callback({ locale, effect: (effect) => effect() })
    },
    effect(effect) {
      return effect()
    },
    betterSidebar: {
      hostRouteUrl: (path) => 'http://host/' + path,
      registerFileViewer: () => () => {},
    },
  }
  exports.apply(ctx)
  exports.__test.NotebookView({
    ctx,
    store: {},
    scope: { sessionId: 'session-1' },
    path: '/workspace/demo.ipynb',
    title: 'demo.ipynb',
    viewerId: 'dsh-bsb-ipynb:notebook',
    customData: { status: 'loading' },
  })
  assert.equal(typeof captured.subscribe, 'function')
  assert.equal(typeof captured.getSnapshot, 'function')
  assert.equal(captured.getSnapshot(), 1)
  const unsubscribe = captured.subscribe(() => {})
  assert.equal(listeners.size, 1, 'the viewer subscribes to the host locale face')
  unsubscribe()
  assert.equal(listeners.size, 0)
  revision = 2
  assert.equal(captured.getSnapshot(), 2, 'revision changes reach useSyncExternalStore')
})

test('load posts the session and path and converts host failures into an error payload', async () => {
  const scenarios = [
    {
      name: 'success',
      path: '/workspace/demo.ipynb',
      sessionId: 'session-1',
      response: { ok: true, status: 200, body: { ok: true, value: { status: 'ok', notebook: { cells: [] }, version: 'a'.repeat(64) } } },
      verify(value, calls) {
        assert.equal(value.status, 'ok', 'success: the host payload is returned unchanged')
        assert.equal(calls[0].url, 'http://host/ipynb/read', 'success: the read host route is used')
        const body = JSON.parse(calls[0].init.body)
        assert.deepEqual(body, { sessionId: 'session-1', path: '/workspace/demo.ipynb' }, 'success: the session and path are posted')
      },
    },
    {
      name: 'host failure',
      path: '/etc/passwd',
      sessionId: 's1',
      response: { ok: false, status: 403, body: { ok: false, error: { code: 'path-outside-root', message: 'outside' } } },
      verify(value) {
        assert.deepEqual(value, { status: 'error', code: 'path-outside-root', message: 'outside' }, 'host failure: the error payload replaces a throw')
      },
    },
  ]
  const originalFetch = globalThis.fetch
  try {
    for (const scenario of scenarios) {
      const { exports } = await loadClient()
      const calls = []
      globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        return {
          ok: scenario.response.ok,
          status: scenario.response.status,
          async json() {
            return scenario.response.body
          },
        }
      }
      assert.ok(exports.__test, `${scenario.name}: the test API is exposed`)
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
      const value = await ctx.viewer.load(scenario.path, { sessionId: scenario.sessionId })
      assert.equal(calls.length, 1, `${scenario.name}: exactly one host request is made`)
      scenario.verify(value, calls)
    }
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

test('markdown escapes code, URLs and image attributes exactly once', async () => {
  const { exports } = await loadClient()
  const { renderMarkdown, renderMarkdownWithImages } = exports.__test
  assert.equal(
    renderMarkdown('`a&b <x>`'),
    '<p><code>a&amp;b &lt;x&gt;</code></p>',
  )
  const links = renderMarkdown('[query](https://example.test/?a=1&b=2)\n\nhttps://example.test/?a=1&b=2')
  assert.equal(links.includes('a=1&amp;b=2'), true)
  assert.equal(links.includes('&amp;amp;'), false)
  assert.equal(
    renderMarkdown('![a&b](img/a&b.png)'),
    '<p><img src="img/a&amp;b.png" alt="a&amp;b" loading="lazy"></p>',
  )
  assert.equal(
    renderMarkdownWithImages('![a&b](img/a&b.png)', (source) => '/sidebar/file?src=' + encodeURIComponent(source)),
    '<p><img src="/sidebar/file?src=img%2Fa%26b.png" alt="a&amp;b" loading="lazy"></p>',
  )
})

test('inline emphasis never rewrites link attributes or image names', async () => {
  const { exports } = await loadClient()
  const { renderMarkdown, renderMarkdownWithImages } = exports.__test
  assert.equal(
    renderMarkdown('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))'),
    '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noreferrer noopener">wiki</a></p>',
  )
  assert.equal(
    renderMarkdown('[q](https://example.test/?user_id=1&my_param=2)'),
    '<p><a href="https://example.test/?user_id=1&amp;my_param=2" target="_blank" rel="noreferrer noopener">q</a></p>',
  )
  assert.equal(
    renderMarkdown('see https://example.test/a_b_c now'),
    '<p>see <a href="https://example.test/a_b_c" target="_blank" rel="noreferrer noopener">https://example.test/a_b_c</a> now</p>',
  )
  assert.equal(
    renderMarkdown('![alt_a_b](img/my_image_v2.png)'),
    '<p><img src="img/my_image_v2.png" alt="alt_a_b" loading="lazy"></p>',
  )
  assert.equal(
    renderMarkdownWithImages('![alt_a_b](img/my_image_v2.png)', (source) => '/sidebar/file?path=' + encodeURIComponent(source)),
    '<p><img src="/sidebar/file?path=img%2Fmy_image_v2.png" alt="alt_a_b" loading="lazy"></p>',
  )
})

test('inline emphasis still applies to plain text and code spans stay literal', async () => {
  const { exports } = await loadClient()
  const { renderMarkdown } = exports.__test
  assert.equal(
    renderMarkdown('**bold** and __strong__ and ~~gone~~'),
    '<p><strong>bold</strong> and <strong>strong</strong> and <del>gone</del></p>',
  )
  assert.equal(renderMarkdown('*em* / _em_'), '<p><em>em</em> / <em>em</em></p>')
  assert.equal(renderMarkdown('`a_b *c*`'), '<p><code>a_b *c*</code></p>')
  assert.equal(renderMarkdown('a\u0000\u0001b'), '<p>ab</p>')
  assert.equal(
    renderMarkdown('[**bold** link](https://example.test)'),
    '<p><a href="https://example.test" target="_blank" rel="noreferrer noopener"><strong>bold</strong> link</a></p>',
  )
  assert.equal(
    renderMarkdown('[`a_b`](https://example.test)'),
    '<p><a href="https://example.test" target="_blank" rel="noreferrer noopener"><code>a_b</code></a></p>',
  )
})

test('hostile markup cannot add attributes to generated links or images', async () => {
  const { exports } = await loadClient()
  const { renderMarkdown } = exports.__test
  const payloads = [
    '[x](https://example.test/"><img src=x onerror=alert(1)>)',
    '![x" onerror="alert(1)](img.png)',
    '[x" onmouseover="alert(1)](https://example.test)',
  ]
  for (const payload of payloads) {
    const html = renderMarkdown(payload)
    assert.doesNotMatch(html, /\son(?:error|mouseover|load|click)="/i, payload)
    assert.doesNotMatch(html, /<img src=x/i, payload)
    assert.doesNotMatch(html, /<script/i, payload)
  }
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

test('protocol-relative images are refused while links keep working', async () => {
  const { exports } = await loadClient()
  const { sanitizeUrl, renderMarkdown } = exports.__test
  assert.equal(sanitizeUrl('//evil.example/pixel.png', { image: true }), null)
  assert.equal(sanitizeUrl('//example.com/page'), '//example.com/page')
  const html = renderMarkdown('![pixel](//evil.example/pixel.png)')
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /pixel/)
})

test('markdown image resolver rewrites local images and drops missing ones', async () => {
  const { exports } = await loadClient()
  const { renderMarkdownWithImages } = exports.__test
  const scenarios = [
    {
      name: 'resolved local image',
      markdown: '![plot](img/plot.png)',
      resolver: () => '/sidebar/file?path=%2Fws%2Fimg%2Fplot.png',
      expected: '<p><img src="/sidebar/file?path=%2Fws%2Fimg%2Fplot.png" alt="plot" loading="lazy"></p>',
    },
    {
      name: 'missing image',
      markdown: '![plot](missing.png)',
      resolver: () => null,
      expected: '<p><span class="dsh-bsb-ipynb-missing-image">plot</span></p>',
    },
  ]
  for (const scenario of scenarios) {
    assert.equal(
      renderMarkdownWithImages(scenario.markdown, scenario.resolver),
      scenario.expected,
      `${scenario.name}: unexpected rendered image markup`,
    )
  }
})

test('html sanitizer degrades to escaped text when DOM cleaning throws', async () => {
  const { exports } = await loadClient()
  const { sanitizeHtml } = exports.__test
  const original = globalThis.DOMParser
  try {
    globalThis.DOMParser = class {
      parseFromString() {
        return {
          body: {
            get childNodes() {
              throw new RangeError('Maximum call stack size exceeded')
            },
          },
        }
      }
    }
    assert.equal(sanitizeHtml('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;')
  } finally {
    if (original === undefined) delete globalThis.DOMParser
    else globalThis.DOMParser = original
  }
})

test('html sanitizer resolves attachment and local images through the image resolver', async () => {
  const restore = installDomParser()
  try {
    const { exports } = await loadClient()
    const { sanitizeHtml } = exports.__test
    const resolved = []
    const html = sanitizeHtml(
      '<p><img src="attachment:plot.png" alt="plot">' +
        '<img src="images/local.png" alt="local">' +
        '<img src="https://example.test/remote.png" alt="remote">' +
        '<img src="C:\\pics\\a.png" alt="win">' +
        '<img src="\\\\server\\share\\a.png" alt="unc"></p>',
      {
        resolveImage(src) {
          resolved.push(src)
          return 'http://host/sidebar/file?path=' + encodeURIComponent(src)
        },
      },
    )
    assert.deepEqual(resolved, [
      'attachment:plot.png',
      'images/local.png',
      'https://example.test/remote.png',
      'C:\\pics\\a.png',
      '\\\\server\\share\\a.png',
    ], 'every whitelisted image source is offered to the resolver unchanged')
    assert.equal(
      html,
      '<p><img src="http://host/sidebar/file?path=attachment%3Aplot.png" alt="plot">' +
        '<img src="http://host/sidebar/file?path=images%2Flocal.png" alt="local">' +
        '<img src="http://host/sidebar/file?path=https%3A%2F%2Fexample.test%2Fremote.png" alt="remote">' +
        '<img src="http://host/sidebar/file?path=C%3A%5Cpics%5Ca.png" alt="win">' +
        '<img src="http://host/sidebar/file?path=%5C%5Cserver%5Cshare%5Ca.png" alt="unc"></p>',
    )
  } finally {
    restore()
  }
})

test('html sanitizer keeps the URL policy, strips disallowed attributes and only resolves safe image sources', async () => {
  const restore = installDomParser()
  try {
    const { exports } = await loadClient()
    const { sanitizeHtml } = exports.__test
    const resolved = []
    const html = sanitizeHtml(
      '<img src="javascript:alert(1)"><img src="//evil.example/pixel.png">' +
        '<img src="file:///C:/pics/a.png"><img src="data:text/html;base64,AAAA">' +
        '<img src="data:image/png;base64,AAAA">' +
        '<p style="color:red" onclick="alert(1)" class="keep-me">styled</p>',
      {
        resolveImage(src) {
          resolved.push(src)
          return src
        },
      },
    )
    assert.deepEqual(resolved, ['data:image/png;base64,AAAA'], 'unsafe sources are dropped before resolution')
    assert.doesNotMatch(html, /javascript:/)
    assert.doesNotMatch(html, /evil\.example/)
    assert.doesNotMatch(html, /file:\/\//)
    assert.doesNotMatch(html, /data:text\/html/)
    assert.match(html, /data:image\/png;base64,AAAA/)
    assert.match(html, /<p class="keep-me">styled<\/p>/, 'allowed attributes and text survive sanitization')
    assert.doesNotMatch(html, /style=/, 'inline style attributes are removed from HTML outputs')
    assert.doesNotMatch(html, /onclick=/, 'inline event handlers are removed from HTML outputs')
  } finally {
    restore()
  }
})

test('html sanitizer degrades unresolvable images to the missing-image marker', async () => {
  const restore = installDomParser()
  try {
    const { exports } = await loadClient()
    const { sanitizeHtml } = exports.__test
    const html = sanitizeHtml('<p>before <img src="attachment:missing.png" alt="gone"> after</p>', { resolveImage: () => null })
    assert.equal(html, '<p>before <span class="dsh-bsb-ipynb-missing-image">gone</span> after</p>')
    const thrown = sanitizeHtml('<p><img src="attachment:bad.png" alt="bad">x</p>', {
      resolveImage() {
        throw new Error('boom')
      },
    })
    assert.equal(thrown, '<p><span class="dsh-bsb-ipynb-missing-image">bad</span>x</p>',
      'a failing resolver only degrades its image, not the whole output')
  } finally {
    restore()
  }
})

test('html sanitizer fallback ignores the image resolver and still escapes markup', async () => {
  const { exports } = await loadClient()
  const { sanitizeHtml } = exports.__test
  assert.equal(typeof globalThis.DOMParser, 'undefined', 'this environment has no DOMParser')
  const resolved = []
  const html = sanitizeHtml('<img src="attachment:plot.png"><b>x</b><script>alert(1)</script>', {
    resolveImage(src) {
      resolved.push(src)
      return 'http://host/file'
    },
  })
  assert.deepEqual(resolved, [], 'there is no DOM to rewrite in the fallback path')
  assert.doesNotMatch(html, /<img|<script/)
  assert.match(html, /&lt;img src=&quot;attachment:plot\.png&quot;&gt;/)
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/, 'the no-DOM fallback escapes ordinary markup in full')
})

test('html output images are rewritten before rendering', async () => {
  const restore = installDomParser()
  try {
    const { exports } = await loadClient()
    const { OutputView } = exports.__test
    const tree = OutputView({
      output: { output_type: 'display_data', data: { 'text/html': '<div><img src="attachment:plot.png" alt="plot"></div>' } },
      resolveImage: (src) => '/sidebar/file?path=' + encodeURIComponent(src),
    })
    assert.equal(tree.type, 'div')
    assert.match(tree.props.className, /dsh-bsb-ipynb-html/)
    assert.equal(
      tree.props.dangerouslySetInnerHTML.__html,
      '<div><img src="/sidebar/file?path=attachment%3Aplot.png" alt="plot"></div>',
    )
  } finally {
    restore()
  }
})

test('reading-mode shortcut resolver handles modifiers, IME and already-handled events', async () => {
  const { exports } = await loadClient()
  const { resolveReadingShortcut, cellIdFromEventTarget } = exports.__test
  const context = { targetCellId: 'cell-1', activeCellId: 'cell-9' }
  assert.deepEqual(resolveReadingShortcut({ key: 'Enter', ctrlKey: true }, context), { action: 'run', cellId: 'cell-1' })
  assert.deepEqual(resolveReadingShortcut({ key: 'Enter', metaKey: true }, context), { action: 'run', cellId: 'cell-1' })
  assert.deepEqual(
    resolveReadingShortcut({ key: 'Enter', ctrlKey: true }, { activeCellId: 'cell-9' }),
    { action: 'run', cellId: 'cell-9' },
    'the focused cell wins, then the most recently edited/run cell',
  )
  assert.equal(resolveReadingShortcut({ key: 'Enter', ctrlKey: true }, {}), null, 'never runs a cell by guessing')
  assert.equal(resolveReadingShortcut({ key: 'Enter' }, context), null, 'plain Enter is not a shortcut')
  assert.deepEqual(resolveReadingShortcut({ key: 's', ctrlKey: true }, context), { action: 'save', cellId: null })
  assert.deepEqual(resolveReadingShortcut({ key: 'S', ctrlKey: true }, context), { action: 'save', cellId: null }, 'CapsLock')
  assert.deepEqual(resolveReadingShortcut({ code: 'KeyS', key: 'Unidentified', metaKey: true }, context), { action: 'save', cellId: null })
  assert.equal(resolveReadingShortcut({ key: 's', ctrlKey: true, isComposing: true }, context), null, 'IME composition')
  assert.equal(resolveReadingShortcut({ key: 's', ctrlKey: true, keyCode: 229 }, context), null, 'IME keyCode 229')
  assert.equal(
    resolveReadingShortcut({ key: 's', ctrlKey: true, defaultPrevented: true }, context),
    null,
    'the cell editor already handled the event',
  )
  assert.equal(resolveReadingShortcut({ key: 's', ctrlKey: true, repeat: true }, context), null, 'held Ctrl+S auto-repeat')
  assert.equal(resolveReadingShortcut({ key: 'Enter', ctrlKey: true, repeat: true }, context), null, 'held Ctrl+Enter auto-repeat')
  assert.deepEqual(
    resolveReadingShortcut({ key: 's', ctrlKey: true, repeat: false }, context),
    { action: 'save', cellId: null },
    'the initial press is still handled',
  )
  assert.equal(resolveReadingShortcut({ key: 's', ctrlKey: true, target: { tagName: 'TEXTAREA' } }, context), null)
  assert.equal(resolveReadingShortcut({ key: 'Enter', ctrlKey: true, target: { tagName: 'TEXTAREA' } }, context), null)
  assert.equal(resolveReadingShortcut({ key: 's', ctrlKey: true, target: { isContentEditable: true } }, context), null)

  // Cell target lookup walks the DOM ancestors to the data-cell-id container.
  const cellContainer = { getAttribute: (name) => (name === 'data-cell-id' ? 'cell-7' : null), parentNode: null }
  const pre = { getAttribute: () => null, parentNode: { getAttribute: () => null, parentNode: cellContainer } }
  assert.equal(cellIdFromEventTarget(pre), 'cell-7')
  assert.equal(cellIdFromEventTarget({ getAttribute: () => null, parentNode: null }), null)
  assert.equal(cellIdFromEventTarget(null), null)
})

test('stream output and text MIME values join array parts without comma separators', async () => {
  const { exports } = await loadClient()
  const { OutputView, mimeText } = exports.__test
  const tree = OutputView({
    output: { output_type: 'stream', name: 'stdout', text: ['alpha\n', 'beta\n'] },
    resolveImage: () => null,
  })
  assert.equal(tree.type, 'pre')
  const html = tree.props.dangerouslySetInnerHTML.__html
  assert.match(html, /alpha\nbeta/)
  assert.doesNotMatch(html, /alpha,beta|,beta/)
  const scenarios = [
    { name: 'array lines', input: ['line one\n', 'line two'], expected: 'line one\nline two' },
    { name: 'scalar string', input: 'plain', expected: 'plain' },
    { name: 'null value', input: null, expected: '' },
  ]
  for (const scenario of scenarios) {
    assert.equal(mimeText(scenario.input), scenario.expected, `${scenario.name}: unexpected text MIME join`)
  }
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

test('notebook normalization and serialization strip nbformat-illegal output fields', async () => {
  const { exports } = await loadClient()
  const { normalizeNotebook, serializeNotebook } = exports.__test

  // Stage 1: loading a notebook drops illegal output fields but keeps a valid
  // execution_count on execute_result.
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
  const normalizedOutputs = notebook.cells[0].outputs
  assert.equal('execution_count' in normalizedOutputs[0], false)
  assert.equal('display_id' in normalizedOutputs[0], false)
  assert.equal(normalizedOutputs[1].execution_count, 2)
  assert.equal('display_id' in normalizedOutputs[1], false)

  // Stage 2: serialization applies the same strip to outputs that still carry
  // the illegal fields, including stream and error outputs.
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
  const serializedOutputs = parsed.cells[0].outputs
  assert.equal('execution_count' in serializedOutputs[0], false)
  assert.equal('display_id' in serializedOutputs[0], false)
  assert.equal(serializedOutputs[1].execution_count, 3)
  assert.equal('display_id' in serializedOutputs[1], false)
  assert.equal('execution_count' in serializedOutputs[2], false)
  assert.equal('display_id' in serializedOutputs[3], false)
  // The original invalid input must not be mutated by serialization.
  assert.equal('display_id' in serializedOutputs[2], false)
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

test('notebook capacity caches default results by snapshot identity and bypasses custom limits', async () => {
  const { exports } = await loadClient()
  const { notebookCapacity, METADATA_DEPTH_LIMIT } = exports.__test
  const snapshot = notebookWithMetadata({})
  const first = notebookCapacity(snapshot)
  assert.equal(first.ok, true)
  assert.equal(notebookCapacity(snapshot), first, 'the same snapshot reuses its result without serializing again')

  const custom = notebookCapacity(snapshot, first.bytes - 1)
  assert.notStrictEqual(custom, first, 'a custom limit cannot consume the cached default result')
  assert.deepEqual(custom, { ok: false, bytes: first.bytes })
  assert.notStrictEqual(notebookCapacity(snapshot, first.bytes - 1), custom, 'custom-limit results are not cached')
  assert.equal(notebookCapacity(snapshot), first, 'a custom-limit call cannot overwrite the default result')

  const nextSnapshot = { ...snapshot }
  const next = notebookCapacity(nextSnapshot)
  assert.notStrictEqual(next, first, 'a new snapshot is measured again even when its contents are equal')
  assert.deepEqual(next, first)
  assert.equal(notebookCapacity(nextSnapshot), next)

  const failedSnapshot = notebookWithMetadata(nestedMetadata(METADATA_DEPTH_LIMIT + 1))
  const failed = notebookCapacity(failedSnapshot)
  assert.equal(failed.ok, false)
  assert.equal(notebookCapacity(failedSnapshot), failed, 'failure results are cached too')
})

function notebookWithMetadata(metadata, location = 'notebook') {
  const notebook = {
    cells: [{
      id: 'cell-1',
      cell_type: 'code',
      source: '',
      execution_count: null,
      metadata: {},
      outputs: [{ output_type: 'display_data', data: {}, metadata: {} }],
    }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }
  if (location === 'notebook') notebook.metadata = metadata
  else if (location === 'cell') notebook.cells[0].metadata = metadata
  else notebook.cells[0].outputs[0].metadata = metadata
  return notebook
}

function nestedMetadata(depth) {
  let metadata = {}
  for (let index = 0; index < depth; index += 1) metadata = { child: metadata }
  return metadata
}

test('metadata depth preflight covers notebook, cell and output metadata', async () => {
  const { exports } = await loadClient()
  const { serializeNotebook, notebookCapacity, METADATA_DEPTH_LIMIT, METADATA_NODE_LIMIT } = exports.__test
  assert.equal(METADATA_DEPTH_LIMIT, 100)
  assert.equal(METADATA_NODE_LIMIT, 10_000)
  for (const location of ['notebook', 'cell', 'output']) {
    const notebook = notebookWithMetadata(nestedMetadata(METADATA_DEPTH_LIMIT + 1), location)
    assert.throws(() => serializeNotebook(notebook), (error) => {
      assert.equal(error.code, 'metadata-too-complex')
      assert.match(error.message, /maximum depth of 100/)
      return true
    })
    assert.deepEqual(notebookCapacity(notebook), { ok: false, reason: 'metadata-too-complex', bytes: 0 })
  }
})

test('metadata node limits and normal depth and node boundaries are enforced exactly', async () => {
  const { exports } = await loadClient()
  const { serializeNotebook, notebookCapacity, METADATA_DEPTH_LIMIT, METADATA_NODE_LIMIT } = exports.__test
  assert.doesNotThrow(() => serializeNotebook(notebookWithMetadata(nestedMetadata(METADATA_DEPTH_LIMIT))))
  assert.doesNotThrow(() => serializeNotebook(notebookWithMetadata(new Array(METADATA_NODE_LIMIT - 1).fill(null))))

  const tooManyNodes = notebookWithMetadata(new Array(METADATA_NODE_LIMIT).fill(null))
  assert.throws(() => serializeNotebook(tooManyNodes), (error) => {
    assert.equal(error.code, 'metadata-too-complex')
    assert.match(error.message, /maximum node count of 10000/)
    return true
  })
  assert.deepEqual(notebookCapacity(tooManyNodes), { ok: false, reason: 'metadata-too-complex', bytes: 0 })

  const shared = { value: 'shared references are not cycles' }
  assert.doesNotThrow(() => serializeNotebook(notebookWithMetadata({ left: shared, right: shared })))
})

test('metadata cycles keep the original TypeError serialization behavior', async () => {
  const { exports } = await loadClient()
  const { serializeNotebook, notebookCapacity } = exports.__test
  for (const location of ['notebook', 'cell', 'output']) {
    const metadata = {}
    metadata.circular = metadata
    const notebook = notebookWithMetadata(metadata, location)
    assert.throws(() => serializeNotebook(notebook), TypeError)
    assert.throws(() => notebookCapacity(notebook), TypeError)
  }
})

test('save preflight rejects toJSON hooks without executing them', async () => {
  const { exports } = await loadClient()
  const { notebookCapacity } = exports.__test
  let called = false
  const notebook = notebookWithMetadata({})
  notebook.cells[0].outputs[0].data = {
    'application/json': {
      toJSON() {
        called = true
        throw new RangeError('Invalid string length')
      },
    },
  }
  assert.throws(() => notebookCapacity(notebook), /toJSON hooks are not supported/)
  assert.equal(called, false)
})

test('metadata capacity failure stores translatable state and reloads notebook metadata problems', async () => {
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
  const { NotebookView, STRINGS, METADATA_DEPTH_LIMIT, bannerText } = exports.__test
  const tree = NotebookView({
    ctx: {},
    scope: {},
    path: '/workspace/demo.ipynb',
    visible: false,
    customData: {
      status: 'ok',
      version: 'v1',
      notebook: notebookWithMetadata(nestedMetadata(METADATA_DEPTH_LIMIT + 1)),
    },
  })
  tree.props.children[0].props.onSave()
  const banner = stateCalls.map((call) => call.value).find((value) => value && value.reason === 'metadata-too-complex')
  assert.ok(banner)
  const strings = /^zh/i.test(globalThis.navigator?.language || '') ? STRINGS.zh : STRINGS.en
  assert.equal(banner.key, 'metadataTooComplex')
  assert.equal(Object.hasOwn(banner, 'text'), false, 'static text must not be frozen into banner state')
  assert.equal(bannerText(banner), strings.metadataTooComplex)
  assert.equal(banner.action, 'reload', 'clearing outputs cannot repair notebook metadata')
  assert.equal(typeof STRINGS.en.metadataTooComplex, 'string')
  assert.equal(typeof STRINGS.zh.metadataTooComplex, 'string')
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
  const { saveButtonDisabled, isStaleSaveResponse } = exports.__test
  // The document generation predicate is the direct contract for late save
  // responses; keep it locked here after the standalone mirror test was merged.
  assert.equal(isStaleSaveResponse(2, 1), true, 'a response from an older document generation is stale')
  assert.equal(isStaleSaveResponse(1, 1), false)
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

test('every cell editor exposes its localized cell type as an accessible name', async () => {
  const { exports } = await loadClient()
  const { CellView, STRINGS } = exports.__test
  const strings = /^zh/i.test(globalThis.navigator?.language || '') ? STRINGS.zh : STRINGS.en
  for (const [cellType, label] of [
    ['code', strings.codeCell],
    ['markdown', strings.markdownCell],
    ['raw', strings.rawCell],
  ]) {
    const tree = CellView({
      cell: { id: 'cell-1', cell_type: cellType, execution_count: null, metadata: {}, outputs: [], source: '' },
      index: 0,
      count: 1,
      editing: true,
      running: false,
    })
    const editor = tree.props.children[1]
    assert.equal(editor.type, 'textarea', cellType)
    assert.equal(editor.props['aria-label'], label, cellType)
  }
})

test('raw and source editors have keyboard focus rings without changing source focus', async () => {
  const { exports, styles } = await loadClient()
  exports.apply({
    effect: (effect) => effect(),
    betterSidebar: {
      hostRouteUrl: (path) => 'http://host/' + path,
      registerFileViewer: () => () => {},
    },
  })
  const css = styles[0].textContent
  assert.match(
    css,
    /\.dsh-bsb-ipynb-raw:focus-visible,\s*\.dsh-bsb-ipynb-source-editor:focus-visible\s*\{[^}]*outline: 2px solid var\(--dsh-bsb-ipynb-focus\)/,
  )
  assert.ok(
    css.includes('.dsh-bsb-ipynb-source:focus { outline: 1px solid var(--dsh-bsb-ipynb-focus); outline-offset: -1px; }'),
    'the existing reading-mode source focus rule remains intact',
  )
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

test('markdown fences follow CommonMark closing rules and accept info strings', async () => {
  const { exports } = await loadClient()
  const { renderMarkdown } = exports.__test
  const scenarios = [
    {
      name: 'longer closing fence',
      markdown: '````\ncode\n````\nafter',
      verify(html, name) {
        assert.match(html, /<code>code<\/code>/, `${name}: the code body is rendered`)
        assert.match(html, /<p>after<\/p>/, `${name}: a longer closing fence ends the block`)
        assert.equal((html.match(/<pre/g) || []).length, 1, `${name}: the fence opens exactly one block`)
      },
    },
    {
      name: 'python info string',
      markdown: '```python title="x"\ncode\n```',
      verify(html, name) {
        assert.match(html, /class="language-python"/, `${name}: the first info token becomes the language class`)
        assert.match(html, /<code[^>]*>code<\/code>/, `${name}: the code body is rendered`)
      },
    },
    {
      name: 'shorter closing fence',
      markdown: '````\ncode\n```\nmore\n````',
      verify(html, name) {
        assert.match(html, /code\n```\nmore/, `${name}: a shorter fence does not close the block`)
      },
    },
    {
      name: 'c++ info string',
      markdown: '```c++\nint x;\n```',
      verify(html, name) {
        assert.match(html, /class="language-c\+\+"/, `${name}: c++ keeps its language class`)
      },
    },
    {
      name: 'c# info string',
      markdown: '```c#\nint x;\n```',
      verify(html, name) {
        assert.match(html, /class="language-c#"/, `${name}: c# keeps its language class`)
      },
    },
  ]
  for (const scenario of scenarios) {
    scenario.verify(renderMarkdown(scenario.markdown), scenario.name)
  }
})

test('deeply nested blockquotes are capped instead of overflowing the stack', async () => {
  const { exports } = await loadClient()
  const { renderMarkdown } = exports.__test
  let html
  assert.doesNotThrow(() => { html = renderMarkdown('>'.repeat(8000) + ' x') })
  assert.match(html, /<blockquote>/)
  assert.ok((html.match(/<blockquote>/g) || []).length <= 65, 'nesting depth is capped')
  assert.ok(html.length < 40000, 'the escaped remainder stays bounded')
})

test('image data URIs require an image MIME type', async () => {
  const { exports } = await loadClient()
  const { imageSource } = exports.__test
  assert.equal(imageSource('abc', 'text/plain'), '')
  assert.equal(imageSource('abc', 'application/json'), '')
  assert.match(imageSource('abc', 'image/png'), /^data:image\/png;base64,abc$/)
  assert.match(imageSource('<svg></svg>', 'image/svg+xml'), /^data:image\/svg\+xml;base64,/)
})

test('sanitizeUrl keeps Windows local image paths for the local resolver', async () => {
  const { exports } = await loadClient()
  const { sanitizeUrl } = exports.__test
  assert.equal(sanitizeUrl('C:\\pics\\a.png', { image: true }), 'C:\\pics\\a.png')
  assert.equal(sanitizeUrl('C:/pics/a.png', { image: true }), 'C:/pics/a.png')
  assert.equal(sanitizeUrl('\\\\server\\share\\a.png', { image: true }), '\\\\server\\share\\a.png')
  assert.equal(sanitizeUrl('C:\\pics\\a.png'), null, 'local paths are not valid link destinations')
  assert.equal(sanitizeUrl('javascript:alert(1)', { image: true }), null)
  assert.equal(sanitizeUrl('file:///C:/pics/a.png', { image: true }), null)
})

test('makeImageResolver resolves images next to a Windows absolute notebook path', async () => {
  const { exports } = await loadClient()
  const { makeImageResolver, normalizePosix } = exports.__test
  const ctx = { betterSidebar: { hostRouteUrl: (route) => 'http://host/' + route } }
  const scope = { sessionId: 's1', cwd: 'C:\\Users\\me\\notes' }
  const filePath = (resolved) => new URL(resolved).searchParams.get('path')
  const resolve = makeImageResolver(ctx, scope, 'C:\\Users\\me\\notes\\nb\\demo.ipynb', { attachments: {} })
  assert.equal(filePath(resolve('images/plot.png')), 'C:/Users/me/notes/nb/images/plot.png')
  assert.equal(new URL(resolve('images/plot.png')).searchParams.get('sessionId'), 's1')
  assert.equal(filePath(resolve('C:\\pics\\a.png')), 'C:/pics/a.png')

  // UNC keeps its //server/share prefix for both direct and notebook-relative images.
  assert.equal(normalizePosix('\\\\server\\share\\plot.png'), '//server/share/plot.png')
  assert.equal(normalizePosix('//server/share/./plot.png'), '//server/share/plot.png')
  assert.equal(filePath(resolve('\\\\server\\share\\plot.png')), '//server/share/plot.png')
  const uncNotebook = makeImageResolver(ctx, scope, '\\\\server\\share\\notes\\demo.ipynb', {})
  assert.equal(filePath(uncNotebook('images/plot.png')), '//server/share/notes/images/plot.png')

  // POSIX absolute and session-relative notebook paths keep their old behavior.
  const posix = makeImageResolver(ctx, scope, '/Users/me/notes/demo.ipynb', {})
  assert.equal(filePath(posix('img/a.png')), '/Users/me/notes/img/a.png')
  const relative = makeImageResolver(ctx, scope, 'examples/demo.ipynb', {})
  assert.equal(filePath(relative('img/a.png')), 'C:/Users/me/notes/examples/img/a.png')

  // Remote/data/attachment sources are unchanged.
  assert.equal(resolve('https://example.com/a.png'), 'https://example.com/a.png')
  assert.equal(resolve('data:image/png;base64,aaaa'), 'data:image/png;base64,aaaa')
  assert.equal(resolve('attachment:missing.png'), null)
})

test('shortcut hints use platform modifiers in English and Chinese with a safe fallback', async () => {
  const originalNavigator = globalThis.navigator
  const ctrlEn = 'Ctrl+Enter run, Shift+Enter run and advance, Alt+Enter add cell below, Ctrl+S save'
  const cmdEn = 'Cmd+Enter run, Shift+Enter run and advance, Alt+Enter add cell below, Cmd+S save'
  const ctrlZh = 'Ctrl+Enter 运行，Shift+Enter 运行并跳到下一个，Alt+Enter 在下方插入，Ctrl+S 保存'
  const cmdZh = 'Cmd+Enter 运行，Shift+Enter 运行并跳到下一个，Alt+Enter 在下方插入，Cmd+S 保存'
  const cases = [
    { language: 'en-US', platform: 'MacIntel', expected: cmdEn, mac: true },
    { language: 'en-US', platform: 'Win32', expected: ctrlEn, mac: false },
    { language: 'zh-CN', platform: 'MacIntel', expected: cmdZh, mac: true },
    { language: 'zh-CN', platform: 'Win32', expected: ctrlZh, mac: false },
    { language: 'en-US', platform: 'Linux x86_64', expected: ctrlEn, mac: false },
    { missing: true, expected: ctrlEn, mac: false },
  ]
  try {
    for (const entry of cases) {
      globalThis.navigator = entry.missing
        ? undefined
        : { language: entry.language, languages: [entry.language], platform: entry.platform }
      const { exports } = await loadClient()
      assert.equal(exports.__test.shortcutText(), entry.expected)
      assert.equal(exports.__test.isMacPlatform(), entry.mac)
    }
  } finally {
    globalThis.navigator = originalNavigator
  }
})

test('cell shortcuts ignore IME composition and accept CapsLock Ctrl+S', async () => {
  const { exports } = await loadClient()
  const { isImeKeyEvent, isSaveShortcut } = exports.__test
  assert.equal(isSaveShortcut({ key: 's', ctrlKey: true }), true)
  assert.equal(isSaveShortcut({ key: 'S', ctrlKey: true }), true, 'CapsLock reports an uppercase key')
  assert.equal(isSaveShortcut({ key: 'S', metaKey: true }), true)
  assert.equal(isSaveShortcut({ code: 'KeyS', key: 'Unidentified', ctrlKey: true }), true)
  assert.equal(isSaveShortcut({ key: 'S', ctrlKey: false }), false)
  assert.equal(isSaveShortcut({ key: 'S', ctrlKey: true, isComposing: true }), false)
  assert.equal(isSaveShortcut({ key: 'S', ctrlKey: true, keyCode: 229 }), false)
  assert.equal(isImeKeyEvent({ isComposing: true }), true)
  assert.equal(isImeKeyEvent({ keyCode: 229 }), true)
  assert.equal(isImeKeyEvent({ nativeEvent: { isComposing: true } }), true)
  assert.equal(isImeKeyEvent({}), false)
})

test('python highlighting normalizes CRLF source', async () => {
  const { exports } = await loadClient()
  const { highlightPython } = exports.__test
  const html = highlightPython('# note\r\nprint(1)\r\n')
  assert.doesNotMatch(html, /\r/, 'carriage returns must not survive in token spans')
  assert.match(html, /tok-comment/)
})

test('dedentSourceLine removes one indent unit from the caret line', async () => {
  const { exports } = await loadClient()
  const { dedentSourceLine } = exports.__test
  assert.deepEqual(dedentSourceLine('    x', 6), { source: 'x', caret: 2 })
  assert.deepEqual(dedentSourceLine('a\n    b', 7), { source: 'a\nb', caret: 3 })
  assert.deepEqual(dedentSourceLine('abc', 1), { source: 'abc', caret: 1 })
})

test('splitSourceLines keeps trailing newlines like the old lookbehind split', async () => {
  const { exports } = await loadClient()
  const { splitSourceLines } = exports.__test
  assert.deepEqual(splitSourceLines('a\nb\n'), ['a\n', 'b\n'])
  assert.deepEqual(splitSourceLines('a'), ['a'])
  assert.deepEqual(splitSourceLines(''), [])
})

test('output rendering covers MIME priority, fallbacks, image aliases and sanitization', async () => {
  const { exports } = await loadClient()
  const { OutputView } = exports.__test
  const render = (output) => OutputView({ output, resolveImage: () => null })
  assert.equal(render(null), null)

  const stream = render({ output_type: 'stream', name: 'stderr', text: 'oops\n' })
  assert.match(stream.props.className, /stream-stderr/)
  assert.match(stream.props.dangerouslySetInnerHTML.__html, /oops/)

  const error = render({ output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['Traceback'] })
  assert.match(error.props.className, /is-error|dsh-bsb-ipynb-error/)
  assert.match(error.props.dangerouslySetInnerHTML.__html, /Traceback/)

  const html = render({ output_type: 'display_data', data: { 'text/html': '<script>alert(1)</script>' } })
  assert.match(html.props.className, /html/)
  // DOMParser is unavailable in this harness, so the sanitizer falls back to escaping.
  assert.doesNotMatch(html.props.dangerouslySetInnerHTML.__html, /<script>/)

  const emptyHtml = render({ output_type: 'display_data', data: { 'text/html': '', 'text/plain': 'plain fallback' } })
  assert.equal(emptyHtml.props.children[0], 'plain fallback', 'empty text/html falls back to text/plain')

  const svg = render({ output_type: 'display_data', data: { 'image/svg+xml': '<svg></svg>' } })
  assert.match(svg.props.src, /^data:image\/svg\+xml;base64,/)
  const images = render({ output_type: 'display_data', data: { 'image/png': 'pngdata', 'image/jpeg': 'jpgdata' } })
  assert.match(images.props.src, /^data:image\/png;base64,pngdata$/, 'png wins over jpeg')
  const jpgAlias = render({ output_type: 'display_data', data: { 'image/jpg': 'jpgdata' } })
  assert.match(jpgAlias.props.src, /^data:image\/jpeg;base64,jpgdata$/, 'image/jpg is normalized to image/jpeg')
  const image = render({ output_type: 'display_data', data: { 'image/png': 'AAAA' }, metadata: {} })
  assert.equal(image.type, 'img', 'image outputs render an img element')
  assert.equal(image.props.alt, 'Notebook output image', 'image outputs carry localized alt text')

  const markdown = render({ output_type: 'display_data', data: { 'text/markdown': '**bold**' } })
  assert.match(markdown.props.className, /markdown/)
  assert.match(markdown.props.dangerouslySetInnerHTML.__html, /<strong>bold<\/strong>/)

  const json = render({ output_type: 'display_data', data: { 'application/json': { a: 1 } } })
  assert.equal(json.props.children[0], '{\n  "a": 1\n}')
  const jsonString = render({ output_type: 'display_data', data: { 'application/json': 'hello' } })
  assert.equal(jsonString.props.children[0], '"hello"', 'a top-level JSON string stays quoted')
  const jsonBigInt = render({ output_type: 'display_data', data: { 'application/json': 1n } })
  assert.equal(jsonBigInt.props.children[0], '[unserializable JSON output]', 'unserializable JSON output degrades instead of throwing')
  const latex = render({ output_type: 'display_data', data: { 'text/latex': '$x$' } })
  assert.equal(latex.props.children[0], '$x$')
  const plain = render({ output_type: 'display_data', data: { 'text/plain': 'plain' } })
  assert.equal(plain.props.children[0], 'plain')

  const unknown = render({ output_type: 'display_data', data: { 'application/x-custom': 1 } })
  assert.match(unknown.props.children[0], /application\/x-custom/)
})

test('client and server notebook limits stay in parity', async () => {
  const { exports } = await loadClient()
  const client = exports.__test
  assert.equal(client.NOTEBOOK_CAP_BYTES, NOTEBOOK_CAP_BYTES)
  assert.equal(client.METADATA_DEPTH_LIMIT, METADATA_DEPTH_LIMIT)
  assert.equal(client.METADATA_NODE_LIMIT, METADATA_NODE_LIMIT)
})

test('ansi output handles carriage returns and strips OSC sequences', async () => {
  const { exports } = await loadClient()
  const { ansiToHtml } = exports.__test
  const progress = ansiToHtml('10%\r50%\r100%')
  assert.doesNotMatch(progress, /\r/)
  assert.match(progress, /100%$/)
  assert.doesNotMatch(progress, /10%/, 'only the last carriage-return segment survives')

  const title = ansiToHtml('\u001b]0;my title\u0007hello')
  assert.doesNotMatch(title, /my title/)
  assert.match(title, /hello/)

  const hyperlink = ansiToHtml('\u001b]8;;https://example.com\u0007click\u001b]8;;\u0007')
  assert.match(hyperlink, /click/)
  assert.doesNotMatch(hyperlink, /example\.com/)

  const colored = ansiToHtml('\u001b[31mred\u001b[0m')
  assert.match(colored, /color:#cd3131/)
  // Merged SGR + CSI coverage: colors survive, plain text is preserved and the
  // non-SGR control sequence is stripped instead of leaking an escape byte.
  const mixed = ansiToHtml('\u001b[31mred\u001b[0m plain\u001b[2K')
  assert.match(mixed, /<span style="color:#cd3131">red<\/span>/)
  assert.match(mixed, / plain/)
  assert.doesNotMatch(mixed, /\u001b/)
})
