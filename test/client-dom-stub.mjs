// Minimal DOM test double for the real branch of client.js sanitizeHtml().
//
// The plugin client is a hand-written browser artifact with no build step and
// Node has no DOMParser, so the whitelist cleaner used to be tested only
// through its no-DOM fallback. This file implements just the node surface
// cleanNode() touches (elements, text, attributes, child lists, fragments,
// remove/replaceWith and innerHTML serialization) so the tests can drive the
// production code without adding jsdom as a dependency.
//
// It is deliberately not a browser: no layout, no CSS, no events and only the
// HTML subset produced by notebook outputs. Do not use it outside tests.

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

const RAW_TEXT_TAGS = new Set(['script', 'style'])

const ATTRIBUTE_UNESCAPE = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" }

function decodeEntities(value) {
  return String(value).replace(/&(amp|lt|gt|quot|#39|apos);/g, (match, name) => ATTRIBUTE_UNESCAPE[name] ?? match)
}

function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

const HTML_NS_ELEMENT = 1
const TEXT_NODE = 3
const DOCUMENT_FRAGMENT_NODE = 11

class StubNode {
  constructor(document, nodeType, nodeName) {
    this.ownerDocument = document
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.parentNode = null
    this.childNodes = []
  }

  get firstChild() {
    return this.childNodes[0] || null
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child)
    if (index !== -1) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  replaceWith(replacement) {
    const parent = this.parentNode
    if (!parent) return
    const index = parent.childNodes.indexOf(this)
    if (index === -1) return
    if (replacement.nodeType === DOCUMENT_FRAGMENT_NODE) {
      const children = replacement.childNodes.slice()
      replacement.childNodes.length = 0
      for (const child of children) child.parentNode = parent
      parent.childNodes.splice(index, 1, ...children)
    } else {
      if (replacement.parentNode) replacement.parentNode.removeChild(replacement)
      replacement.parentNode = parent
      parent.childNodes.splice(index, 1, replacement)
    }
    this.parentNode = null
  }
}

class StubText extends StubNode {
  constructor(document, data) {
    super(document, TEXT_NODE, '#text')
    this.data = String(data ?? '')
  }

  get textContent() {
    return this.data
  }
}

class StubFragment extends StubNode {
  constructor(document) {
    super(document, DOCUMENT_FRAGMENT_NODE, '#document-fragment')
  }
}

class StubElement extends StubNode {
  constructor(document, tagName) {
    super(document, HTML_NS_ELEMENT, String(tagName || '').toUpperCase())
    this.tagMap = new Map()
  }

  get tagName() {
    return this.nodeName
  }

  get attributes() {
    return Array.from(this.tagMap, ([name, value]) => ({ name, value }))
  }

  getAttribute(name) {
    const key = String(name).toLowerCase()
    return this.tagMap.has(key) ? this.tagMap.get(key) : null
  }

  setAttribute(name, value) {
    this.tagMap.set(String(name).toLowerCase(), String(value))
  }

  removeAttribute(name) {
    this.tagMap.delete(String(name).toLowerCase())
  }

  get textContent() {
    return this.childNodes.map((child) => (child.nodeType === TEXT_NODE ? child.data : child.textContent)).join('')
  }

  set textContent(value) {
    this.childNodes.length = 0
    this.appendChild(new StubText(this.ownerDocument, value))
  }

  get innerHTML() {
    return this.childNodes.map(serializeNode).join('')
  }
}

class StubDocument {
  constructor() {
    this.body = new StubElement(this, 'body')
  }

  createElement(tagName) {
    return new StubElement(this, tagName)
  }

  createDocumentFragment() {
    return new StubFragment(this)
  }
}

function serializeNode(node) {
  if (node.nodeType === TEXT_NODE) return escapeText(node.data)
  if (node.nodeType !== HTML_NS_ELEMENT) return ''
  const tag = node.tagName.toLowerCase()
  let html = '<' + tag
  for (const [name, value] of node.tagMap) html += ' ' + name + '="' + escapeAttribute(value) + '"'
  html += '>'
  if (VOID_TAGS.has(tag)) return html
  return html + node.childNodes.map(serializeNode).join('') + '</' + tag + '>'
}

const ATTRIBUTE_PATTERN = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g

function parseAttributes(source, element) {
  ATTRIBUTE_PATTERN.lastIndex = 0
  let match
  while ((match = ATTRIBUTE_PATTERN.exec(source || '')) !== null) {
    const name = match[1]
    if (!name) continue
    const raw = match[2] ?? match[3] ?? match[4] ?? ''
    element.setAttribute(name, decodeEntities(raw))
  }
}

const END_TAG_PATTERN = /^<\/\s*([a-zA-Z][\w:-]*)\s*>/
const START_TAG_PATTERN = /^<([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/

function parseInto(document, html) {
  const stack = [document.body]
  const source = String(html ?? '')
  let index = 0
  while (index < source.length) {
    const next = source.indexOf('<', index)
    if (next === -1) {
      if (index < source.length) appendText(document, stack[stack.length - 1], source.slice(index))
      break
    }
    if (next > index) appendText(document, stack[stack.length - 1], source.slice(index, next))
    if (source.startsWith('<!--', next)) {
      const end = source.indexOf('-->', next + 4)
      index = end === -1 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<!', next) || source.startsWith('<?', next)) {
      const end = source.indexOf('>', next)
      index = end === -1 ? source.length : end + 1
      continue
    }
    const rest = source.slice(next)
    const endTag = END_TAG_PATTERN.exec(rest)
    if (endTag) {
      const tag = endTag[1].toLowerCase()
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].tagName.toLowerCase() === tag) {
          stack.length = depth
          break
        }
      }
      index = next + endTag[0].length
      continue
    }
    const startTag = START_TAG_PATTERN.exec(rest)
    if (!startTag) {
      // A stray '<' is text, not a tag.
      appendText(document, stack[stack.length - 1], '<')
      index = next + 1
      continue
    }
    const tag = startTag[1].toLowerCase()
    const element = document.createElement(tag)
    parseAttributes(startTag[2], element)
    stack[stack.length - 1].appendChild(element)
    index = next + startTag[0].length
    if (VOID_TAGS.has(tag) || startTag[3] === '/') continue
    if (RAW_TEXT_TAGS.has(tag)) {
      const lower = source.toLowerCase()
      const closeIndex = lower.indexOf('</' + tag, index)
      const content = closeIndex === -1 ? source.slice(index) : source.slice(index, closeIndex)
      if (content) element.appendChild(new StubText(document, content))
      if (closeIndex === -1) {
        index = source.length
      } else {
        const close = source.indexOf('>', closeIndex)
        index = close === -1 ? source.length : close + 1
      }
      continue
    }
    stack.push(element)
  }
}

function appendText(document, parent, text) {
  if (!text) return
  parent.appendChild(new StubText(document, decodeEntities(text)))
}

export class StubDOMParser {
  parseFromString(html, type) {
    if (type !== 'text/html') throw new Error('StubDOMParser only supports text/html')
    const document = new StubDocument()
    parseInto(document, html)
    return document
  }
}

/**
 * Install the stub as globalThis.DOMParser (the production sanitizer looks the
 * constructor up at call time) and return a restore function.
 */
export function installDomParser() {
  const previous = globalThis.DOMParser
  globalThis.DOMParser = StubDOMParser
  return () => {
    if (previous === undefined) delete globalThis.DOMParser
    else globalThis.DOMParser = previous
  }
}
