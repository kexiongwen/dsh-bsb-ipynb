import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { loadClient } from './client-harness.mjs'

// Evaluate the shipped package-local chunk exactly as the browser would: the
// classic script calls window.__ModuleLoader__.load and hands back a factory.
function loadKatexModule() {
  const source = readFileSync(new URL('../client.katex.js', import.meta.url), 'utf8')
  let registration = null
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(value) { registration = value },
      },
    },
    console,
    setTimeout,
    clearTimeout,
  })
  assert.ok(registration, 'the chunk registers through the module loader')
  assert.equal(registration.id, 'dsh-bsb-ipynb')
  assert.equal(registration.chunk, 'client.katex.js')
  return registration.factory(() => {})
}

test('vendored KaTeX chunk registers once and renders formulas', () => {
  const katex = loadKatexModule()
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(katex.version, '0.19.1')
  assert.equal(katex.version, manifest.devDependencies.katex,
    'the shipped chunk must match the pinned dev dependency')
  assert.equal(typeof katex.renderToString, 'function')
  const html = katex.renderToString('E=mc^2', { output: 'mathml', throwOnError: true, trust: false })
  assert.match(html, /<math /)
  assert.match(html, /annotation encoding="application\/x-tex"/)
})

test('KaTeX renderer is bounded, caches results and degrades rejected formulas', async () => {
  const { exports } = await loadClient()
  const {
    createMathRenderer, KATEX_SOURCE_LIMIT,
  } = exports.__test
  const renderMath = createMathRenderer(loadKatexModule())
  assert.equal(typeof renderMath, 'function')

  const inline = renderMath('x_1', false)
  const display = renderMath('\\frac{a}{b}', true)
  assert.match(inline, /<math /)
  assert.match(display, /display="block"/)
  assert.equal(renderMath('x_1', false), inline, 'identical formulas reuse the cached markup')
  assert.equal(renderMath('\\notacommand{', false), null, 'invalid TeX keeps the literal source')
  assert.equal(renderMath('x'.repeat(KATEX_SOURCE_LIMIT + 1), false), null, 'oversized formulas are refused')
  assert.equal(createMathRenderer(null), null)
  assert.equal(createMathRenderer({}), null)

  // The renderer output is injected as HTML outside sanitizeHtml for Markdown,
  // so raw markup in the formula must stay escaped text.
  const hostile = renderMath('<img src=x onerror=alert(1)>', false)
  if (hostile !== null) assert.doesNotMatch(hostile, /<img/i)
})

test('Markdown renders inline and display math without touching code or prices', async () => {
  const { exports } = await loadClient()
  const { renderMarkdown, renderInline, createMathRenderer } = exports.__test
  const renderMath = createMathRenderer(loadKatexModule())

  const inline = renderMarkdown('Inline $x_1$ and \\(y^2\\) finish.', { renderMath })
  assert.match(inline, /class="katex"/)
  assert.equal((inline.match(/class="katex"/g) || []).length, 2)

  const block = renderMarkdown('$$\n\\frac{a}{b}\n$$', { renderMath })
  assert.match(block, /<div class="dsh-bsb-ipynb-math">/)
  assert.match(block, /display="block"/)

  const bracket = renderMarkdown('\\[\ny = 1\n\\]', { renderMath })
  assert.match(bracket, /class="dsh-bsb-ipynb-math"/)
  assert.match(bracket, /display="block"/)

  const inlineDisplay = renderMarkdown('before $$z$$ after', { renderMath })
  assert.match(inlineDisplay, /before <span class="katex">/)
  assert.match(inlineDisplay, /display="block"/)

  for (const source of [
    '`$x$`',
    '```\n$x$\n```',
    'cost $5 and $6',
    '\\$x$ stays escaped',
    'an unmatched $formula',
  ]) {
    assert.doesNotMatch(renderMarkdown(source, { renderMath }), /class="katex"/, `${source} stays literal`)
  }

  // Underscores and asterisks inside TeX must never become Markdown emphasis.
  assert.doesNotMatch(renderMarkdown('$a_1 * b_2$', { renderMath }), /<em>|<strong>/)

  // The same renderer is available through the inline entry point used by
  // headings, list items and table cells.
  assert.match(renderInline('$x$', { renderMath }), /class="katex"/)
  // A formula inside a link label still restores into the anchor.
  assert.match(renderMarkdown('[$x$](https://example.com)', { renderMath }), /<a [^>]*>.*class="katex"/)
  // A link with a normal URL still works when math parsing is enabled.
  assert.match(renderMarkdown('[site](https://example.com/a_(b))', { renderMath }), /href="https:\/\/example\.com\/a_\(b\)"/)
  // Without a renderer the source survives, and display blocks fall back to a
  // readable literal block instead of disappearing.
  assert.match(renderMarkdown('$x$'), /\$x\$/)
  assert.match(renderMarkdown('$$x$$'), /dsh-bsb-ipynb-math-source/)
})

test('text/latex and text/markdown outputs use the same math renderer', async () => {
  const { exports } = await loadClient()
  const { OutputView, createMathRenderer } = exports.__test
  const renderMath = createMathRenderer(loadKatexModule())
  const render = (output, renderer) => OutputView({ output, resolveImage: null, renderMath: renderer })

  const latex = render({ output_type: 'display_data', data: { 'text/latex': 'x^2' }, metadata: {} }, renderMath)
  assert.equal(latex.type, 'div')
  assert.match(latex.props.className, /dsh-bsb-ipynb-math/)
  assert.match(latex.props.dangerouslySetInnerHTML.__html, /class="katex"/)

  const latexFallback = render({ output_type: 'display_data', data: { 'text/latex': '$x$' }, metadata: {} }, null)
  assert.equal(latexFallback.type, 'pre')
  assert.match(latexFallback.props.className, /dsh-bsb-ipynb-math-source/)
  assert.equal(latexFallback.props.children[0], '$x$')

  const markdown = render({ output_type: 'display_data', data: { 'text/markdown': 'value $x$' }, metadata: {} }, renderMath)
  assert.match(markdown.props.dangerouslySetInnerHTML.__html, /class="katex"/)
  const markdownFallback = render({ output_type: 'display_data', data: { 'text/markdown': 'value $x$' }, metadata: {} }, null)
  assert.match(markdownFallback.props.dangerouslySetInnerHTML.__html, /\$x\$/)
})

test('math preload detection covers Markdown cells and latex/markdown outputs only', async () => {
  const { exports } = await loadClient()
  const { notebookHasMath } = exports.__test
  const markdown = (source) => ({ cell_type: 'markdown', source })
  const code = (source, outputs = []) => ({ cell_type: 'code', source, outputs })
  assert.equal(notebookHasMath({ cells: [markdown('$x$')] }), true)
  assert.equal(notebookHasMath({ cells: [markdown('\\(x\\)')] }), true)
  assert.equal(notebookHasMath({ cells: [markdown('\\[x\\]')] }), true)
  assert.equal(notebookHasMath({ cells: [markdown('$$\nx\n$$')] }), true)
  assert.equal(notebookHasMath({
    cells: [code('', [{ output_type: 'display_data', data: { 'text/latex': 'x' }, metadata: {} }])],
  }), true)
  assert.equal(notebookHasMath({
    cells: [code('', [{ output_type: 'display_data', data: { 'text/markdown': 'a $x$ b' }, metadata: {} }])],
  }), true)
  assert.equal(notebookHasMath({ cells: [markdown('plain text')] }), false)
  assert.equal(notebookHasMath({ cells: [code('print("$HOME")')] }), false,
    'a dollar sign in code is not a formula')
  assert.equal(notebookHasMath({
    cells: [code('', [{ output_type: 'error', ename: 'E', evalue: '$x$', traceback: [] }])],
  }), false)
  assert.equal(notebookHasMath(null), false)
})

test('math preload detection follows backslash escape parity', async () => {
  const { exports } = await loadClient()
  const { sourceHasMath, renderMarkdown, createMathRenderer } = exports.__test
  const renderMath = createMathRenderer(loadKatexModule())
  for (const source of [String.raw`\\$x$`, String.raw`\\\\$x$`]) {
    assert.equal(sourceHasMath(source), true, `${JSON.stringify(source)} contains an unescaped formula`)
    assert.match(renderMarkdown(source, { renderMath }), /class="katex"/)
  }
  for (const source of [String.raw`\$x$`, String.raw`\\\$x$`]) {
    assert.equal(sourceHasMath(source), false, `${JSON.stringify(source)} contains only an escaped dollar`)
    assert.doesNotMatch(renderMarkdown(source, { renderMath }), /class="katex"/)
  }
})

test('lazy loader tolerates a host without chunk support and retries failures', async () => {
  const plain = await loadClient()
  assert.equal(await plain.exports.__test.loadMathRenderer(), null)
  assert.equal(await plain.exports.__test.loadMathRenderer(), null, 'a failed load is retried later')

  const fakeKatex = {
    renderToString(source, options) {
      return `<span class="fake-katex" data-display="${Boolean(options.displayMode)}">${source}</span>`
    },
  }
  const loaded = await loadClient({}, fakeKatex)
  const renderMath = await loaded.exports.__test.loadMathRenderer()
  assert.equal(typeof renderMath, 'function')
  assert.match(renderMath('a+b', false), /class="fake-katex"/)
  assert.equal(await loaded.exports.__test.loadMathRenderer(), renderMath, 'the successful load is cached')

  let attempts = 0
  const flaky = await loadClient({}, () => {
    attempts += 1
    if (attempts === 1) throw new Error('network down')
    return fakeKatex
  })
  assert.equal(await flaky.exports.__test.loadMathRenderer(), null)
  assert.equal(typeof (await flaky.exports.__test.loadMathRenderer()), 'function')
  assert.equal(attempts, 2)
})
