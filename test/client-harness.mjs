import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Pin the browser fallback locale: Node exposes a global navigator whose
// language follows the host region (e.g. zh-CN on a Chinese Windows install),
// which would otherwise make English assertions depend on the OS.
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en-US', languages: ['en-US'] },
  configurable: true,
  writable: true,
})

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))
let loadCount = 0

/**
 * Load the client artifact in a minimal fake browser: capture the injected
 * stylesheet, expose the plugin exports, and stub React with plain objects.
 * Each call re-imports the module with a fresh cache-busting query.
 */
export async function loadClient(reactOverrides = {}) {
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
    useSyncExternalStore() {},
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
