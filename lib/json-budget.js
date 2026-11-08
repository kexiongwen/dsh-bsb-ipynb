/**
 * Measure JSON-like data without creating the serialized document. The result
 * excludes any trailing newline. Objects must be plain data objects; accessors
 * and callable toJSON hooks are rejected instead of executing user code.
 *
 * Keep this function self-contained: the unbundled browser client uses a copy.
 */
export function measureJsonBytes(value, {
  limit = Infinity,
  space = 2,
  nodeLimit = 1_000_000,
  depthLimit = 100,
} = {}) {
  if (typeof limit !== 'number' || Number.isNaN(limit) || limit < 0
    || typeof nodeLimit !== 'number' || Number.isNaN(nodeLimit) || nodeLimit < 0
    || typeof depthLimit !== 'number' || Number.isNaN(depthLimit) || depthLimit < 0
    || typeof space !== 'number' || Number.isNaN(space)) {
    throw new TypeError('JSON budgets and indentation must be non-negative numbers')
  }
  const indent = Math.min(10, Math.max(0, Math.trunc(space)))
  const active = new Set()
  const stack = []
  let bytes = 0
  let nodes = 0

  function fail(reason) {
    const error = new Error(reason === 'bytes'
      ? 'JSON exceeds its byte limit'
      : `JSON exceeds its ${reason} limit`)
    error.code = reason === 'bytes' ? 'json-too-large' : 'json-too-complex'
    error.reason = reason
    // A lower bound is sufficient after early termination.
    error.bytes = bytes
    throw error
  }

  function add(count) {
    bytes += count
    if (bytes > limit) fail('bytes')
  }

  function stringBytes(text) {
    add(2)
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (code === 0x22 || code === 0x5c
        || code === 0x08 || code === 0x09 || code === 0x0a
        || code === 0x0c || code === 0x0d) {
        add(2)
      } else if (code < 0x20) {
        add(6)
      } else if (code < 0x80) {
        add(1)
      } else if (code < 0x800) {
        add(2)
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(4)
          index += 1
        } else {
          add(6)
        }
      } else {
        add(code >= 0xdc00 && code <= 0xdfff ? 6 : 3)
      }
    }
  }

  function descriptorValue(object, key, inherited = false) {
    let owner = object
    while (owner !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key)
      if (descriptor) {
        if (!Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('JSON accessors are not supported')
        }
        return descriptor.value
      }
      if (!inherited) break
      owner = Object.getPrototypeOf(owner)
    }
    return undefined
  }

  function omitted(item) {
    return item === undefined || typeof item === 'function' || typeof item === 'symbol'
  }

  function visit(item, depth) {
    nodes += 1
    if (nodes > nodeLimit) fail('nodes')
    if (depth > depthLimit) fail('depth')
    if (item === null || omitted(item)) {
      add(4)
    } else if (typeof item === 'string') {
      stringBytes(item)
    } else if (typeof item === 'number') {
      add(Number.isFinite(item) ? String(item).length : 4)
    } else if (typeof item === 'boolean') {
      add(item ? 4 : 5)
    } else if (typeof item !== 'object') {
      throw new TypeError('Value cannot be represented as JSON')
    } else {
      const array = Array.isArray(item)
      const prototype = Object.getPrototypeOf(item)
      // Checking the prototype's parent also accepts objects from another realm.
      if (!array && prototype !== null && Object.getPrototypeOf(prototype) !== null) {
        throw new TypeError('Only plain JSON data objects are supported')
      }
      if (typeof descriptorValue(item, 'toJSON', true) === 'function') {
        throw new TypeError('JSON toJSON hooks are not supported')
      }
      if (active.has(item)) throw new TypeError('Converting circular structure to JSON')
      add(2)
      active.add(item)
      stack.push({ item, depth, array, keys: array ? null : Object.keys(item), index: 0, written: 0 })
    }
  }

  if (omitted(value)) throw new TypeError('Value cannot be represented as JSON')
  visit(value, 0)
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    const length = frame.array ? frame.item.length : frame.keys.length
    if (frame.index >= length) {
      if (indent && frame.written > 0) add(1 + frame.depth * indent)
      active.delete(frame.item)
      stack.pop()
      continue
    }
    const key = frame.array ? String(frame.index) : frame.keys[frame.index]
    frame.index += 1
    const item = descriptorValue(frame.item, key, frame.array)
    if (!frame.array && omitted(item)) continue
    if (frame.written > 0) add(1)
    if (indent) add(1 + (frame.depth + 1) * indent)
    if (!frame.array) {
      stringBytes(key)
      add(indent ? 2 : 1)
    }
    frame.written += 1
    visit(item, frame.depth + 1)
  }
  return bytes
}
