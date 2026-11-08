import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { measureJsonBytes } from '../lib/json-budget.js'

const encodedBytes = (value, space = 2) => new TextEncoder().encode(JSON.stringify(value, null, space)).byteLength

test('JSON budget exactly counts scalar values, escaping, Unicode and indentation', () => {
  const controls = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join('')
  const values = [
    null, true, false, 0, -0, 123, -123.5, 1e-7, 1e21, Number.MIN_VALUE,
    Number.MAX_VALUE, NaN, Infinity, -Infinity, '', 'ascii', 'é汉字😀',
    '"\\/\b\t\n\f\r', controls, '\ud800', '\udfff', '\ud800x\udc00',
    '\ud800\udc00', '\ud800\ud800\udc00\udc00', [], {}, [[], {}],
    { nested: { list: [true, null, '汉字', { '😀\n"': '\udfff' }] } },
  ]
  for (const value of values) {
    for (const space of [0, 1, 2, 4, 10, 20, 1.5, -2, Infinity]) {
      assert.equal(measureJsonBytes(value, { space }), encodedBytes(value, space))
    }
  }
})

test('JSON budget matches JSON property omission and sparse array nulls', () => {
  const object = { absent: undefined, function: () => {}, symbol: Symbol(), present: null }
  const array = [undefined, () => {}, Symbol(), , null]
  const values = [object, array, { nested: object, array }, { toJSON: 'ordinary data' }]
  for (const value of values) assert.equal(measureJsonBytes(value), encodedBytes(value))
  assert.equal(measureJsonBytes({ absent: undefined }, { nodeLimit: 1 }), 2)
  assert.throws(() => measureJsonBytes([undefined], { nodeLimit: 1 }), { reason: 'nodes' })
  for (const value of [undefined, () => {}, Symbol(), 1n, { bigint: 1n }]) {
    assert.throws(() => measureJsonBytes(value), TypeError)
  }
})

test('JSON budget counts shared references at each occurrence and rejects cycles', () => {
  const child = { array: [1, '😀'] }
  const shared = { left: child, right: child }
  assert.equal(measureJsonBytes(shared), encodedBytes(shared))
  const object = {}
  object.self = object
  const array = []
  array.push(array)
  assert.throws(() => measureJsonBytes(object), /circular/)
  assert.throws(() => measureJsonBytes(array), /circular/)
})

test('JSON byte limit accepts the exact UTF-8 size and reports an early lower bound', () => {
  const value = { '汉字😀': ['é\n', { quote: '\\"', lone: '\ud800' }] }
  const size = encodedBytes(value)
  assert.equal(measureJsonBytes(value, { limit: size }), size)
  assert.throws(() => measureJsonBytes(value, { limit: size - 1 }), (error) => {
    assert.equal(error.code, 'json-too-large')
    assert.equal(error.reason, 'bytes')
    assert.ok(error.bytes > size - 1)
    assert.ok(error.bytes <= size)
    return true
  })
  assert.equal(measureJsonBytes(0, { limit: 1 }), 1)
  assert.throws(() => measureJsonBytes(0, { limit: 0 }), { code: 'json-too-large', bytes: 1 })
})

test('JSON structural limits include the root and each repeated value', () => {
  const value = { a: [1, { b: true }] }
  assert.equal(measureJsonBytes(value, { nodeLimit: 5, depthLimit: 3 }), encodedBytes(value))
  for (const options of [{ nodeLimit: 4 }, { depthLimit: 2 }]) {
    assert.throws(() => measureJsonBytes(value, options), (error) => {
      assert.equal(error.code, 'json-too-complex')
      assert.equal(error.reason, options.nodeLimit ? 'nodes' : 'depth')
      assert.ok(error.bytes >= 0)
      return true
    })
  }
  assert.equal(measureJsonBytes({}, { nodeLimit: 1, depthLimit: 0 }), 2)
  assert.throws(() => measureJsonBytes(null, { nodeLimit: 0 }), { reason: 'nodes' })
  const child = { x: 1 }
  assert.throws(() => measureJsonBytes([child, child], { nodeLimit: 4 }), { reason: 'nodes' })
})

test('JSON budget traverses iteratively and stops on deep or wide input', () => {
  let deep = null
  for (let index = 0; index < 10_000; index += 1) deep = [deep]
  assert.throws(() => measureJsonBytes(deep), { code: 'json-too-complex', reason: 'depth' })
  assert.equal(measureJsonBytes(deep, { space: 0, depthLimit: Infinity }), 20_004)
  const wide = Array(100).fill(null)
  Object.defineProperty(wide, 99, { get() { throw new Error('should not reach the tail') } })
  assert.throws(() => measureJsonBytes(wide, { nodeLimit: 10 }), { reason: 'nodes' })
  assert.throws(() => measureJsonBytes(wide, { limit: 10 }), { reason: 'bytes' })
})

test('JSON byte measurement neither stringifies nor UTF-8 encodes the document', (t) => {
  const value = { large: '😀'.repeat(10_000), tail: [1, 2, 3] }
  const expected = encodedBytes(value)
  t.mock.method(JSON, 'stringify', () => { throw new Error('unexpected stringify') })
  t.mock.method(TextEncoder.prototype, 'encode', () => { throw new Error('unexpected encode') })
  assert.equal(measureJsonBytes(value), expected)
  const originalCharCodeAt = String.prototype.charCodeAt
  let scannedUnits = 0
  t.mock.method(String.prototype, 'charCodeAt', function (index) {
    scannedUnits += 1
    return originalCharCodeAt.call(this, index)
  })
  assert.throws(() => measureJsonBytes(value, { limit: 32 }), (error) => {
    assert.equal(error.reason, 'bytes')
    assert.ok(error.bytes > 32 && error.bytes <= 36)
    return true
  })
  assert.ok(scannedUnits < 32, `scanned ${scannedUnits} units despite the small byte budget`)
})

test('JSON budget matches native serialization across deterministic mixed structures', () => {
  let seed = 0x12345678
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x100000000
  }
  const strings = ['', '\u0000', '\b\t\n\r\f', '"\\', 'é汉字', '😀', '\ud800', '\udfff']
  const makeValue = (depth) => {
    const kind = Math.floor(random() * (depth === 0 ? 4 : 6))
    if (kind === 0) return null
    if (kind === 1) return random() < 0.5
    if (kind === 2) return (random() - 0.5) * (random() < 0.5 ? 1e25 : 1e-10)
    if (kind === 3) return strings[Math.floor(random() * strings.length)]
    const length = Math.floor(random() * 5)
    if (kind === 4) return Array.from({ length }, () => makeValue(depth - 1))
    return Object.fromEntries(Array.from({ length }, (_, index) => [
      `${index}${strings[Math.floor(random() * strings.length)]}`, makeValue(depth - 1),
    ]))
  }
  for (let index = 0; index < 200; index += 1) {
    const value = makeValue(5)
    for (const space of [0, 2, 10]) {
      const expected = encodedBytes(value, space)
      assert.equal(measureJsonBytes(value, { space, limit: expected }), expected)
      assert.throws(() => measureJsonBytes(value, { space, limit: expected - 1 }), { reason: 'bytes' })
    }
  }
})

test('JSON budget refuses getters and serialization hooks without calling them', () => {
  let calls = 0
  const accessor = { get payload() { calls += 1; return 1 } }
  const toJSON = { toJSON() { calls += 1; return 1 } }
  const hookAccessor = { get toJSON() { calls += 1; return () => 1 } }
  const arrayAccessor = []
  Object.defineProperty(arrayAccessor, 0, { get() { calls += 1; return 1 } })
  for (const value of [accessor, toJSON, hookAccessor, arrayAccessor]) {
    assert.throws(() => measureJsonBytes(value), TypeError)
  }
  assert.equal(calls, 0)
  for (const value of [new Date(), new Number(1), new String('x'), new Map()]) {
    assert.throws(() => measureJsonBytes(value), TypeError)
  }
})

test('JSON budget supports plain objects from another realm and null prototypes', () => {
  const value = vm.runInNewContext('({ metadata: { name: "汉字" }, list: [1, null] })')
  const nullPrototype = Object.assign(Object.create(null), { value: '😀', nested: value })
  assert.equal(measureJsonBytes(value), encodedBytes(value))
  assert.equal(measureJsonBytes(nullPrototype), encodedBytes(nullPrototype))
})

test('JSON budget rejects invalid configuration', () => {
  for (const options of [
    { limit: -1 }, { limit: NaN }, { limit: '100' },
    { nodeLimit: -1 }, { nodeLimit: NaN }, { depthLimit: -1 },
    { depthLimit: NaN }, { space: '  ' }, { space: NaN },
  ]) assert.throws(() => measureJsonBytes({}, options), TypeError)
})
