/**
 * Helpers for the client theme tests: a tiny CSS rule/declaration parser and a
 * nested `var()` resolver that mimics computed-value resolution. These stay
 * dependency-free so the suite keeps running with a plain `node --test` on
 * every platform.
 */

/** Strip CSS block comments; comments never contain nested terminators here. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Index of the `)` matching the `(` at `openIndex`, or -1. */
function matchingParen(value, openIndex) {
  let depth = 0
  for (let index = openIndex; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1
    else if (value[index] === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Index of the first top-level comma in a string, or -1. */
function topLevelComma(value) {
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 0) return index
  }
  return -1
}

/** Split a declaration body on top-level `;` only. */
function splitTopLevel(value, separator) {
  const parts = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === separator && depth === 0) {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

/**
 * Parse top-level rules of a stylesheet into `{ selectors, body }` entries.
 * Nested blocks (e.g. `@keyframes` frames) stay inside the parent body and are
 * not returned as separate rules.
 */
export function parseRules(css) {
  const source = stripComments(css)
  const rules = []
  let index = 0
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1
    if (index >= source.length) break
    if (source[index] === '}') {
      index += 1
      continue
    }
    const open = source.indexOf('{', index)
    if (open === -1) break
    const selectorText = source.slice(index, open).trim()
    let depth = 0
    let close = open
    while (close < source.length) {
      if (source[close] === '{') depth += 1
      else if (source[close] === '}') {
        depth -= 1
        if (depth === 0) break
      }
      close += 1
    }
    const selectors = selectorText.split(',').map((selector) => selector.trim()).filter(Boolean)
    rules.push({ selectors, body: source.slice(open + 1, close) })
    index = close + 1
  }
  return rules
}

/** All declarations of a rule body as `{ prop, value }` (top level only). */
export function declarationsOf(body) {
  const declarations = []
  for (const part of splitTopLevel(body, ';')) {
    const colon = part.indexOf(':')
    if (colon === -1) continue
    const prop = part.slice(0, colon).trim()
    const value = part.slice(colon + 1).trim()
    if (prop !== '' && value !== '') declarations.push({ prop, value })
  }
  return declarations
}

/** Body of the first rule whose selector list contains `selector` exactly. */
export function ruleBody(css, selector) {
  const rule = parseRules(css).find((entry) => entry.selectors.includes(selector))
  if (!rule) throw new Error('rule not found: ' + selector)
  return rule.body
}

/** First declaration value of `property` in the rule matched by `selector`. */
export function declarationOf(css, selector, property) {
  const body = ruleBody(css, selector)
  const declaration = declarationsOf(body).find((entry) => entry.prop === property)
  if (!declaration) throw new Error(`declaration not found: ${selector} { ${property} }`)
  return declaration.value
}

/** True when the rule declares `property`. */
export function hasDeclaration(css, selector, property) {
  return declarationsOf(ruleBody(css, selector)).some((entry) => entry.prop === property)
}

/**
 * Resolve `var(--name[, fallback])` chains from an innermost-first walk and
 * evaluate the simple `calc(a + b)` expressions the theme layer uses. The
 * result is what the browser would compute for a custom property or length.
 */
export function resolveVars(value, tokens) {
  let output = value
  for (let guard = 0; guard < 100; guard += 1) {
    const start = output.lastIndexOf('var(')
    if (start === -1) break
    const open = start + 3
    const close = matchingParen(output, open)
    if (close === -1) break
    const inner = output.slice(open + 1, close)
    const comma = topLevelComma(inner)
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim()
    const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim()
    let replacement
    if (Object.prototype.hasOwnProperty.call(tokens, name) && tokens[name] !== '') replacement = tokens[name]
    else if (fallback !== undefined) replacement = resolveVars(fallback, tokens)
    else replacement = ''
    output = output.slice(0, start) + replacement + output.slice(close + 1)
  }
  return evaluateCalc(output)
}

/** Remove every `var(...)` span (including nested fallbacks) from a value. */
export function maskVars(value) {
  let output = value
  for (let guard = 0; guard < 100; guard += 1) {
    const start = output.lastIndexOf('var(')
    if (start === -1) return output
    const close = matchingParen(output, start + 3)
    if (close === -1) return output
    output = output.slice(0, start) + ' ' + output.slice(close + 1)
  }
  return output
}

/** Evaluate `calc(<px terms>)`; any other expression is returned unchanged. */
export function evaluateCalc(value) {
  const trimmed = value.trim()
  const match = /^calc\(([\s\S]*)\)$/.exec(trimmed)
  if (!match) return trimmed
  const body = match[1]
  const remainder = body.replace(/[+-]?\s*\d+(?:\.\d+)?px/g, '').replace(/[()+\-*/\s]/g, '')
  if (remainder !== '') return trimmed
  const terms = body.match(/[+-]?\s*\d+(?:\.\d+)?px/g) || []
  let total = 0
  for (const term of terms) total += Number.parseFloat(term.replace(/\s+/g, ''))
  return `${total}px`
}
