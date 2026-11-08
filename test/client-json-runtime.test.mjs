import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClient } from './client-harness.mjs'

function nested(depth, leaf = null) {
  let value = leaf
  for (let index = 0; index < depth; index += 1) value = { child: value }
  return value
}

function assertLimited(outputs) {
  assert.equal(outputs.length, 1)
  assert.equal(outputs[0].output_type, 'stream')
  assert.equal(outputs[0].name, 'stderr')
  assert.match(outputs[0].text, /output limit reached/)
}

test('live JSON output enforces depth and node budgets for JSON and vendor MIME types', async () => {
  const { exports } = await loadClient()
  const { reduceOutputs, JSON_DEPTH_LIMIT, JSON_NODE_LIMIT } = exports.__test
  for (const mime of ['application/json', 'application/vnd.example+json']) {
    for (const value of [nested(JSON_DEPTH_LIMIT + 1), new Array(JSON_NODE_LIMIT).fill(0)]) {
      for (const type of ['display_data', 'execute_result']) {
        const outputs = reduceOutputs([], { type, data: { [mime]: value }, metadata: {} })
        assertLimited(outputs)
        assert.equal(reduceOutputs(outputs, { type: 'stream', text: 'ignored' }), outputs,
          'the rejected payload locks the output until it is cleared')
        assert.deepEqual(reduceOutputs(outputs, { type: 'clear_output', wait: false }), [])
      }
    }
  }
})

test('shared display replacements reject invalid payloads without modifying earlier snapshots', async () => {
  const { exports } = await loadClient()
  const { reduceOutputs, outputsSize, JSON_DEPTH_LIMIT } = exports.__test
  let previous = reduceOutputs([], {
    type: 'display_data', display_id: 'shared', data: { 'application/json': { first: true } }, metadata: {},
  })
  previous = reduceOutputs(previous, {
    type: 'execute_result', display_id: 'shared', execution_count: 3,
    data: { 'application/json': { second: true } }, metadata: {},
  })
  const initial = JSON.stringify(previous)
  const valid = reduceOutputs(previous, {
    type: 'update_display_data', display_id: 'shared',
    data: { 'application/vnd.example+json': { text: '中文😀\n"', values: [null, true, 7] } }, metadata: {},
  })
  assert.deepEqual(valid[0].data, valid[1].data)
  assert.equal(valid[1].execution_count, 3)
  assert.equal(outputsSize(valid), Buffer.byteLength(JSON.stringify(valid)))
  const invalid = {
    type: 'update_display_data', display_id: 'shared',
    data: { 'application/json': nested(JSON_DEPTH_LIMIT + 1) }, metadata: {},
  }
  assertLimited(reduceOutputs(previous, invalid))
  assert.equal(JSON.stringify(previous), initial)
  assert.equal(reduceOutputs(previous, { ...invalid, display_id: 'missing' }), previous,
    'an unmatched update never processes or retains its payload')
})

test('live metadata, cyclic JSON and serialization hooks cannot bypass output validation', async () => {
  const { exports } = await loadClient()
  const { reduceOutputs, METADATA_DEPTH_LIMIT } = exports.__test
  assertLimited(reduceOutputs([], {
    type: 'display_data', data: {}, metadata: nested(METADATA_DEPTH_LIMIT + 1),
  }))
  const cyclic = {}
  cyclic.self = cyclic
  assertLimited(reduceOutputs([], { type: 'display_data', data: { 'application/json': cyclic } }))
  let calls = 0
  const hook = { toJSON() { calls += 1; return 'unvalidated replacement' } }
  assertLimited(reduceOutputs([], { type: 'display_data', data: { 'application/json': hook } }))
  assert.equal(calls, 0)
})

test('live byte budgets measure valid and oversized payloads without serializing or encoding them', async () => {
  const { exports } = await loadClient()
  const { reduceOutputs, MAX_CELL_OUTPUT_BYTES } = exports.__test
  const originalStringify = JSON.stringify
  const originalEncode = TextEncoder.prototype.encode
  let serializationCalls = 0
  let encodingCalls = 0
  JSON.stringify = () => { serializationCalls += 1; throw new Error('unexpected serialization') }
  TextEncoder.prototype.encode = () => { encodingCalls += 1; throw new Error('unexpected encoding') }
  try {
    const valid = reduceOutputs([], {
      type: 'display_data', display_id: 'shared', data: { 'application/json': { result: ['中文😀', 42] } }, metadata: {},
    })
    assert.equal(valid[0].output_type, 'display_data')
    const updated = reduceOutputs(valid, {
      type: 'update_display_data', display_id: 'shared', data: { 'application/json': { result: 43 } }, metadata: {},
    })
    assert.equal(updated[0].data['application/json'].result, 43)
    assertLimited(reduceOutputs([], {
      type: 'display_data', data: { 'application/json': 'x'.repeat(MAX_CELL_OUTPUT_BYTES) }, metadata: {},
    }))
    assert.equal(serializationCalls, 0)
    assert.equal(encodingCalls, 0)
  } finally {
    JSON.stringify = originalStringify
    TextEncoder.prototype.encode = originalEncode
  }
})

test('JSON renderers reject excessive structure and pretty-print expansion before stringifying', async () => {
  const { exports } = await loadClient()
  const { renderJsonOutput, OutputView, JSON_DEPTH_LIMIT, MAX_CELL_OUTPUT_BYTES, measureJsonBytes } = exports.__test
  const expanded = nested(90, 'x'.repeat(MAX_CELL_OUTPUT_BYTES - 1_000))
  assert.ok(measureJsonBytes(expanded, { space: 0 }) < MAX_CELL_OUTPUT_BYTES,
    'the compact payload fits but indentation puts the rendered text above the limit')
  const originalStringify = JSON.stringify
  let calls = 0
  JSON.stringify = () => { calls += 1; throw new Error('unexpected serialization') }
  try {
    assert.equal(renderJsonOutput(nested(JSON_DEPTH_LIMIT + 1)), '[unserializable JSON output]')
    assert.equal(renderJsonOutput(expanded), '[unserializable JSON output]')
    const fallback = OutputView({
      output: { output_type: 'display_data', data: { 'application/vnd.example+json': nested(JSON_DEPTH_LIMIT + 1) } },
    })
    assert.equal(fallback.props.children[0], '[unserializable JSON output]')
    assert.equal(calls, 0)
  } finally {
    JSON.stringify = originalStringify
  }
  assert.equal(renderJsonOutput({ value: '中文😀' }), JSON.stringify({ value: '中文😀' }, null, 2))
  assert.equal(renderJsonOutput('quoted'), '"quoted"')
})
