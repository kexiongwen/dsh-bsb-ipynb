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
let cachedFactory = null
let loadCount = 0

/**
 * Load the client artifact in a minimal fake browser: capture the injected
 * stylesheet, expose the plugin exports, and stub React with plain objects.
 * The artifact is imported once; every call re-runs its factory so the tests
 * still get fresh module state (all plugin state lives inside the factory).
 */
export async function loadClient(reactOverrides = {}) {
  let options = null
  const listeners = new Map()
  // The viewer installs a window keydown listener for its lifetime; keep the
  // minimal browser surface complete so a mounted component never trips over a
  // missing method. Lifecycle tests dispatch through their own harness.
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        options = value
      },
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) {
      if (listeners.has(type)) listeners.get(type).delete(listener)
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
  if (!cachedFactory) {
    await import(pathToFileURL(clientPath).href + '?test=' + Date.now() + '-' + (++loadCount))
    assert.ok(options, 'client artifact registers a module')
    assert.equal(options.id, 'dsh-bsb-ipynb')
    cachedFactory = options.factory
  }
  const exports = cachedFactory((id) => {
    if (id === 'react') return react
    throw new Error('unexpected module: ' + id)
  })
  return { exports, styles }
}
