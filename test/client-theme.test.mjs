import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadClient } from './client-harness.mjs'
import {
  declarationOf,
  declarationsOf,
  hasDeclaration,
  maskVars,
  parseRules,
  resolveVars,
  ruleBody,
} from './theme-helpers.mjs'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/dsh-theme-tokens.json', import.meta.url)), 'utf8'),
)

// Load the artifact once and run `apply` so the plugin-owned stylesheet is
// captured exactly as the host would inject it.
const { exports, styles } = await loadClient()
exports.apply({
  effect: (effect) => effect(),
  betterSidebar: { version: '0.32.1', features: ['hostRouteUrl'],
    hostRouteUrl: (path) => 'http://127.0.0.1:1/' + path,
    registerFileViewer: () => () => {},
  },
})
assert.equal(styles.length, 1, 'the client injects exactly one stylesheet')
const css = styles[0].textContent

/** The plugin's own token layer, parsed from the injected stylesheet. */
function localVars() {
  const vars = {}
  for (const { prop, value } of declarationsOf(ruleBody(css, '.dsh-bsb-ipynb-root'))) {
    if (prop.startsWith('--')) vars[prop] = value
  }
  return vars
}

const LOCALS = localVars()
const REQUIRED_HOST_TOKENS = [
  '--dsw-alias-border-l1',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-markdown-code-block',
  '--dsw-alias-markdown-inline-code',
  '--dsw-alias-link',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-business-primary',
  '--shiki-token-keyword',
  '--shiki-token-string',
  '--shiki-token-comment',
  '--shiki-token-constant',
  '--shiki-token-function',
  '--shiki-token-parameter',
  '--dsh-content-font-size-secondary',
  '--dsh-content-font-delta-secondary',
  '--dsh-code-font-size',
  '--dsh-code-font-delta',
  '--ds-font-family-code',
]

function themeMap(palette) {
  return { ...palette, ...LOCALS }
}

function resolved(palette, selector, property) {
  return resolveVars(declarationOf(css, selector, property), themeMap(palette))
}

/** One sentinel per host token, so a leaked hardcoded value is visible. */
function sentinelPalette() {
  const sentinels = {}
  let index = 0
  for (const [name, value] of Object.entries(fixture.light)) {
    index += 1
    if (name === '--ds-font-family-code') sentinels[name] = `"Sentinel Code ${index}", monospace`
    else if (value.endsWith('px')) sentinels[name] = `${100 + index}px`
    else sentinels[name] = '#' + (0x100000 + index).toString(16)
  }
  return sentinels
}

test('theme colours resolve only through host tokens', () => {
  for (const token of REQUIRED_HOST_TOKENS) {
    assert.ok(css.includes('var(' + token), `styles must consume host token ${token}`)
  }
  assert.doesNotMatch(css, /body\[data-ds-dark-theme\]/, 'the plugin must not select its own dark palette')
  assert.doesNotMatch(css, /@media \(prefers-color-scheme/, 'the OS colour scheme must not override the host theme')
  assert.doesNotMatch(
    css,
    /--dsw-(border-default|text-muted|accent-default|surface-default)/,
    'legacy --dsw-* tokens are outside the current theme contract',
  )

  // Every declaration outside the image surface may only name host tokens; a
  // literal outside a `var(...)` fallback would be unreachable for skins.
  for (const rule of parseRules(css)) {
    const selectors = rule.selectors.join(', ')
    if (selectors === '.dsh-bsb-ipynb-image') continue
    for (const { prop, value } of declarationsOf(rule.body)) {
      const leaked = maskVars(value)
      assert.doesNotMatch(leaked, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, `${selectors} { ${prop} } leaks a hardcoded colour: ${value}`)
    }
  }

  // The one intentional literal: transparent plot assets need a white surface
  // on dark themes. Keep it explicit so the audit above stays meaningful.
  assert.equal(declarationOf(css, '.dsh-bsb-ipynb-image', 'background'), 'white')
})

test('light and dark host palettes reach the notebook through inheritance', () => {
  for (const scheme of ['light', 'dark']) {
    const palette = fixture[scheme]
    assert.equal(resolved(palette, '.dsh-bsb-ipynb-kernel-dot', 'background'), palette['--dsw-alias-label-tertiary'])
    assert.equal(
      resolved(palette, '.dsh-bsb-ipynb-kernel-dot.is-ready', 'background'),
      palette['--dsw-alias-state-success-primary'],
    )
    assert.equal(
      resolved(palette, '.dsh-bsb-ipynb-kernel-dot.is-busy', 'background'),
      palette['--dsw-alias-state-warn-primary'],
    )
    assert.equal(
      resolved(palette, '.dsh-bsb-ipynb-save-state.is-error', 'color'),
      palette['--dsw-alias-state-error-primary'],
    )
    assert.equal(resolved(palette, '.dsh-bsb-ipynb-stream-stderr', 'color'), palette['--dsw-alias-state-error-primary'])
    assert.equal(resolved(palette, '.dsh-bsb-ipynb-error', 'color'), palette['--dsw-alias-state-error-primary'])
    assert.ok(resolved(palette, '.dsh-bsb-ipynb-banner-info', 'background').includes(palette['--dsw-alias-state-business-primary']))
    assert.ok(resolved(palette, '.dsh-bsb-ipynb-banner-error', 'background').includes(palette['--dsw-alias-state-error-primary']))
    assert.equal(resolved(palette, '.dsh-bsb-ipynb-cell', 'background'), palette['--dsw-alias-bg-module-platform'])
    assert.equal(resolved(palette, '.dsh-bsb-ipynb-md-code', 'background'), palette['--dsw-alias-markdown-code-block'])
    assert.equal(resolved(palette, '.dsh-bsb-ipynb-markdown a', 'color'), palette['--dsw-alias-link'])
    assert.equal(resolved(palette, '.dsh-bsb-ipynb-cell-running', 'border-color'), palette['--dsw-alias-state-business-primary'])
    assert.equal(resolved(palette, '.dsh-bsb-ipynb-button:hover:not(:disabled)', 'background'), palette['--dsw-alias-interactive-bg-hover'])
    assert.equal(resolved(palette, '.dsh-bsb-ipynb-source', 'font-size'), '12px')
    assert.equal(resolved(palette, '.dsh-bsb-ipynb-root', 'font-size'), palette['--dsh-content-font-size-secondary'])
    assert.equal(resolved(palette, '.dsh-bsb-ipynb-root', 'color'), palette['--dsw-alias-label-primary'])

    const tokens = {
      keyword: '--shiki-token-keyword',
      string: '--shiki-token-string',
      comment: '--shiki-token-comment',
      number: '--shiki-token-constant',
      builtin: '--shiki-token-function',
      class: '--shiki-token-parameter',
    }
    for (const [kind, token] of Object.entries(tokens)) {
      assert.equal(resolved(palette, '.dsh-bsb-ipynb-tok-' + kind, 'color'), palette[token], `tok-${kind} follows ${token}`)
    }
  }

  // The palette switch itself must be the only difference: light stays light
  // while the OS prefers dark, and vice versa, because no rule reads the OS.
  assert.notEqual(
    resolved(fixture.light, '.dsh-bsb-ipynb-error', 'color'),
    resolved(fixture.dark, '.dsh-bsb-ipynb-error', 'color'),
    'error text must flip with the host palette',
  )
  assert.notEqual(
    resolved(fixture.light, '.dsh-bsb-ipynb-tok-keyword', 'color'),
    resolved(fixture.dark, '.dsh-bsb-ipynb-tok-keyword', 'color'),
    'syntax colours must flip with the host palette',
  )
})

test('every notebook colour follows a skin override', () => {
  const sentinels = sentinelPalette()
  const expect = (selector, property, token) => {
    const value = resolveVars(declarationOf(css, selector, property), { ...sentinels, ...LOCALS })
    assert.ok(value.includes(sentinels[token]), `${selector} { ${property} } must use ${token}, got ${value}`)
  }
  expect('.dsh-bsb-ipynb-kernel-dot', 'background', '--dsw-alias-label-tertiary')
  expect('.dsh-bsb-ipynb-kernel-dot.is-ready', 'background', '--dsw-alias-state-success-primary')
  expect('.dsh-bsb-ipynb-kernel-dot.is-busy', 'background', '--dsw-alias-state-warn-primary')
  expect('.dsh-bsb-ipynb-save-state.is-error', 'color', '--dsw-alias-state-error-primary')
  expect('.dsh-bsb-ipynb-stream-stderr', 'color', '--dsw-alias-state-error-primary')
  expect('.dsh-bsb-ipynb-error', 'color', '--dsw-alias-state-error-primary')
  expect('.dsh-bsb-ipynb-banner-info', 'background', '--dsw-alias-state-business-primary')
  expect('.dsh-bsb-ipynb-banner-error', 'background', '--dsw-alias-state-error-primary')
  expect('.dsh-bsb-ipynb-cell', 'background', '--dsw-alias-bg-module-platform')
  expect('.dsh-bsb-ipynb-md-code', 'background', '--dsw-alias-markdown-code-block')
  expect('.dsh-bsb-ipynb-markdown code', 'background', '--dsw-alias-markdown-inline-code')
  expect('.dsh-bsb-ipynb-markdown a', 'color', '--dsw-alias-link')
  expect('.dsh-bsb-ipynb-cell-running', 'border-color', '--dsw-alias-state-business-primary')
  expect('.dsh-bsb-ipynb-button:hover:not(:disabled)', 'background', '--dsw-alias-interactive-bg-hover')
  expect('.dsh-bsb-ipynb-source', 'font-family', '--ds-font-family-code')
  expect('.dsh-bsb-ipynb-tok-keyword', 'color', '--shiki-token-keyword')
  expect('.dsh-bsb-ipynb-tok-string', 'color', '--shiki-token-string')
  expect('.dsh-bsb-ipynb-tok-comment', 'color', '--shiki-token-comment')
  expect('.dsh-bsb-ipynb-tok-number', 'color', '--shiki-token-constant')
  expect('.dsh-bsb-ipynb-tok-builtin', 'color', '--shiki-token-function')
  expect('.dsh-bsb-ipynb-tok-class', 'color', '--shiki-token-parameter')
})

test('without host tokens the pre-token fallbacks still render the notebook', () => {
  const fallback = (selector, property) => resolveVars(declarationOf(css, selector, property), { ...LOCALS })
  assert.equal(fallback('.dsh-bsb-ipynb-kernel-dot', 'background'), 'rgba(127, 127, 127, 0.55)')
  assert.equal(fallback('.dsh-bsb-ipynb-kernel-dot.is-ready', 'background'), '#2ea043')
  assert.equal(fallback('.dsh-bsb-ipynb-kernel-dot.is-busy', 'background'), '#d29922')
  assert.equal(fallback('.dsh-bsb-ipynb-save-state.is-error', 'color'), '#cf222e')
  assert.equal(fallback('.dsh-bsb-ipynb-stream-stderr', 'color'), '#cf222e')
  assert.equal(fallback('.dsh-bsb-ipynb-tok-keyword', 'color'), '#cf222e')
  assert.equal(fallback('.dsh-bsb-ipynb-tok-string', 'color'), '#0a3069')
  assert.equal(fallback('.dsh-bsb-ipynb-root', 'font-size'), '13px')
  assert.equal(fallback('.dsh-bsb-ipynb-source', 'font-size'), '12px')
  assert.equal(fallback('.dsh-bsb-ipynb-output', 'font-size'), '12px')
  assert.equal(fallback('.dsh-bsb-ipynb-kernel-label', 'font-size'), '11px')
  assert.match(fallback('.dsh-bsb-ipynb-source', 'font-family'), /^ui-monospace/)
  assert.match(fallback('.dsh-bsb-ipynb-banner-info', 'background'), /#4c8dff/)
  assert.match(fallback('.dsh-bsb-ipynb-banner-error', 'background'), /#cf222e/)
})

/** The host derives these two tokens from the saved text/code font sizes. */
function secondarySize(textSize) {
  return Math.min(textSize - 1, Math.max(13, textSize - 2))
}

function fontPalette({ text, code, mono }) {
  const secondary = secondarySize(text)
  return {
    ...fixture.light,
    '--dsh-content-font-size': `${text}px`,
    '--dsh-content-font-size-secondary': `${secondary}px`,
    '--dsh-content-font-delta-secondary': `${secondary - 13}px`,
    '--dsh-code-font-size': `${code}px`,
    '--dsh-code-font-delta': `${code - 11}px`,
    ...(mono === undefined ? {} : { '--ds-font-family-code': mono }),
  }
}

test('DSH font settings scale notebook text and code without changing the defaults', () => {
  const sizeOf = (palette, selector) => resolved(palette, selector, 'font-size')

  const defaults = fontPalette({ text: 14, code: 11 })
  assert.equal(sizeOf(defaults, '.dsh-bsb-ipynb-root'), '13px')
  assert.equal(sizeOf(defaults, '.dsh-bsb-ipynb-kernel-label'), '11px')
  assert.equal(sizeOf(defaults, '.dsh-bsb-ipynb-banner'), '12px')
  assert.equal(sizeOf(defaults, '.dsh-bsb-ipynb-source'), '12px')
  assert.equal(sizeOf(defaults, '.dsh-bsb-ipynb-output'), '12px')
  assert.equal(sizeOf(defaults, '.dsh-bsb-ipynb-md-code'), '12px')
  assert.equal(sizeOf(defaults, '.dsh-bsb-ipynb-prompt'), '11px')

  const large = fontPalette({ text: 18, code: 16 })
  assert.equal(sizeOf(large, '.dsh-bsb-ipynb-root'), '16px')
  assert.equal(sizeOf(large, '.dsh-bsb-ipynb-kernel-label'), '14px')
  assert.equal(sizeOf(large, '.dsh-bsb-ipynb-banner'), '15px')
  assert.equal(sizeOf(large, '.dsh-bsb-ipynb-source'), '17px')
  assert.equal(sizeOf(large, '.dsh-bsb-ipynb-output'), '17px')
  assert.equal(sizeOf(large, '.dsh-bsb-ipynb-md-code'), '17px')
  assert.equal(sizeOf(large, '.dsh-bsb-ipynb-prompt'), '16px')

  const small = fontPalette({ text: 10, code: 10 })
  assert.equal(sizeOf(small, '.dsh-bsb-ipynb-root'), '9px')
  assert.equal(sizeOf(small, '.dsh-bsb-ipynb-kernel-label'), '7px')
  assert.equal(sizeOf(small, '.dsh-bsb-ipynb-banner'), '8px')
  assert.equal(sizeOf(small, '.dsh-bsb-ipynb-source'), '11px')
  assert.equal(sizeOf(small, '.dsh-bsb-ipynb-prompt'), '10px')

  const huge = fontPalette({ text: 22, code: 16 })
  assert.equal(sizeOf(huge, '.dsh-bsb-ipynb-root'), '20px')
  assert.equal(sizeOf(huge, '.dsh-bsb-ipynb-kernel-label'), '18px')

  const customFont = fontPalette({ text: 14, code: 11, mono: '"Cascadia Code", monospace' })
  assert.equal(resolved(customFont, '.dsh-bsb-ipynb-source', 'font-family'), '"Cascadia Code", monospace')
  assert.equal(resolved(customFont, '.dsh-bsb-ipynb-prompt', 'font-family'), '"Cascadia Code", monospace')
  assert.equal(resolved(customFont, '.dsh-bsb-ipynb-md-code', 'font-family'), '"Cascadia Code", monospace')

  // Text font family is inherited from the host body (`--dsw-font-family`);
  // only code contexts name a font family.
  assert.equal(hasDeclaration(css, '.dsh-bsb-ipynb-root', 'font-family'), false)
})
