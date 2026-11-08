import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { measureJsonBytes } from '../lib/json-budget.js'
import {
  JSON_DEPTH_LIMIT, JSON_NODE_LIMIT, METADATA_DEPTH_LIMIT, METADATA_NODE_LIMIT,
  NOTEBOOK_DEPTH_LIMIT, NOTEBOOK_NODE_LIMIT,
  NOTEBOOK_CAP_BYTES, parseNotebookBytes, readNotebookFile, serializeNotebook, saveNotebookFile, sha256,
} from '../lib/notebook.js'
import { loadClient } from './client-harness.mjs'
import { tempDir } from './python-helper.mjs'

function nested(depth, leaf = null) {
  let value = leaf
  for (let index = 0; index < depth; index += 1) value = { child: value }
  return value
}

function notebook(value = null, attachment = false, mime = 'application/json') {
  const cell = { id: 'cell-1', cell_type: 'code', source: '', metadata: {}, execution_count: null,
    outputs: [{ output_type: 'display_data', data: { [mime]: value }, metadata: {} }] }
  if (attachment) {
    cell.cell_type = 'markdown'
    delete cell.outputs
    delete cell.execution_count
    cell.attachments = { 'data.json': { [mime]: value } }
  }
  return { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [cell] }
}

function expandedNotebook() {
  // Each payload obeys the JSON MIME limits (100 levels / 250,000 nodes) and
  // the complete notebook stays below one million nodes. Only pretty-print
  // indentation exceeds 32 MiB.
  const value = nested(90, new Array(9_000).fill(null))
  const result = notebook(value)
  result.cells = Array.from({ length: 21 }, (_, index) => ({ ...result.cells[0], id: 'cell-' + index }))
  return result
}

test('host and browser use identical bounded JSON measurement and limit constants', async () => {
  const { exports } = await loadClient()
  const client = exports.__test
  const body = (fn) => fn.toString().split('\n').map((line) => line.trim()).join('\n')
  assert.equal(body(client.measureJsonBytes), body(measureJsonBytes))
  for (const [name, value] of Object.entries({
    JSON_DEPTH_LIMIT, JSON_NODE_LIMIT, METADATA_DEPTH_LIMIT, METADATA_NODE_LIMIT,
    NOTEBOOK_DEPTH_LIMIT, NOTEBOOK_NODE_LIMIT, NOTEBOOK_CAP_BYTES,
  })) assert.equal(client[name], value, name)
})

test('client preflight covers JSON MIME output and attachments at the exact structural boundaries', async () => {
  const { exports } = await loadClient()
  const { notebookCapacity } = exports.__test
  for (const attachment of [false, true]) {
    for (const mime of ['application/json', 'application/vnd.example+json']) {
      for (const value of [nested(JSON_DEPTH_LIMIT), new Array(JSON_NODE_LIMIT - 1).fill(null)]) {
        assert.equal(notebookCapacity(notebook(value, attachment, mime)).ok, true)
      }
      for (const value of [nested(JSON_DEPTH_LIMIT + 1), nested(4_200), new Array(JSON_NODE_LIMIT).fill(null)]) {
        assert.deepEqual(notebookCapacity(notebook(value, attachment, mime)), {
          ok: false, reason: 'json-too-complex', bytes: 0,
        })
      }
    }
  }
})

test('client aggregate budget spans otherwise valid cells and JSON MIME values', async () => {
  const { exports } = await loadClient()
  const { notebookCapacity } = exports.__test
  const value = new Array(9_999).fill(null)
  const result = notebook(value)
  result.cells = Array.from({ length: 100 }, (_, index) => ({ ...result.cells[0], id: 'cell-' + index }))
  assert.equal(notebookCapacity({ ...result, cells: result.cells.slice(0, 99) }).ok, true)
  assert.deepEqual(notebookCapacity(result), { ok: false, reason: 'json-too-complex', bytes: 0 })
})

test('normal JSON values keep host/client disk byte parity and round-trip without loss', async () => {
  const { exports } = await loadClient()
  const { notebookCapacity, serializeNotebook: serializeClient } = exports.__test
  for (const value of [null, true, false, 1.25, '中文😀\u0000\n"\\\ud800', [null, 3, { key: '值' }], { '键😀': [1, 2] }]) {
    for (const attachment of [false, true]) {
      const result = notebook(value, attachment)
      result.cells[0].source = '中文😀\nsecond\n'
      const hostText = serializeNotebook(result)
      const clientText = serializeClient(result)
      assert.deepEqual(JSON.parse(clientText), JSON.parse(hostText))
      assert.equal(notebookCapacity(result).bytes, Buffer.byteLength(hostText))
    }
  }
})

for (const points of [4_997, 50_000]) {
  test('Plotly scatter with ' + points + ' points remains readable, saveable and usable as live output', async (t) => {
    const { exports } = await loadClient()
    const { notebookCapacity, reduceOutputs, renderJsonOutput } = exports.__test
    const mime = 'application/vnd.plotly.v1+json'
    const payload = {
      data: [{
        type: 'scatter', mode: 'markers',
        x: Array.from({ length: points }, (_, index) => index),
        y: Array.from({ length: points }, (_, index) => 2 * index),
      }],
      layout: { title: { text: 'Scatter 数据' } },
      config: { responsive: true },
    }
    const input = notebook(payload, false, mime)
    const compact = Buffer.from(JSON.stringify(input))
    const parsed = parseNotebookBytes(compact)
    assert.equal(parsed.status, 'ok', 'ordinary chart JSON must not make the whole notebook invalid')
    assert.deepEqual(parsed.notebook.cells[0].outputs[0].data[mime], payload)
    const preflight = notebookCapacity(parsed.notebook)
    assert.equal(preflight.ok, true)
    assert.equal(preflight.bytes, Buffer.byteLength(serializeNotebook(parsed.notebook)))
    const live = reduceOutputs([], { type: 'display_data', data: { [mime]: payload }, metadata: {} })
    assert.equal(live[0].output_type, 'display_data')
    assert.deepEqual(live[0].data[mime], payload)
    assert.equal(renderJsonOutput(payload), JSON.stringify(payload, null, 2))

    const dir = await tempDir(t)
    const file = path.join(dir, 'scatter.ipynb')
    await writeFile(file, compact)
    const loaded = await readNotebookFile(file)
    assert.equal(loaded.status, 'ok')
    const saved = await saveNotebookFile(file, loaded.notebook, loaded.version)
    const disk = await readFile(file)
    assert.equal(saved.version, sha256(disk))
    assert.equal(saved.size, disk.length)
    assert.equal(saved.size, preflight.bytes)
    const reread = await readNotebookFile(file)
    assert.equal(reread.status, 'ok')
    assert.deepEqual(reread.notebook.cells[0].outputs[0].data[mime], payload,
      'read/save must preserve every coordinate and chart option')
  })
}

test('valid notebook serialization preserves a fixed pre-budget byte golden', async () => {
  // Captured from db5ee8444b51fc4dd29cd9adf1fd72a06ef9d872, before JSON
  // budgets were added. Keep this literal independent of the serializers.
  const golden = String.raw`{
  "cells": [
    {
      "cell_type": "code",
      "execution_count": 1,
      "id": "golden-cell",
      "metadata": {},
      "outputs": [
        {
          "output_type": "display_data",
          "data": {
            "application/json": {
              "title": "中文😀",
              "values": [
                null,
                true,
                1.25
              ],
              "text": "line\n\"quote\"\\"
            }
          },
          "metadata": {}
        }
      ],
      "source": [
        "print(\"中文😀\")\n",
        "1 + 1"
      ]
    }
  ],
  "metadata": {
    "custom": {
      "enabled": true
    }
  },
  "nbformat": 4,
  "nbformat_minor": 5
}` + '\n'
  const { exports } = await loadClient()
  const input = JSON.parse(golden)
  assert.equal(serializeNotebook(input), golden)
  assert.equal(exports.__test.serializeNotebook(input), golden)
  const parsed = parseNotebookBytes(Buffer.from(golden))
  assert.equal(parsed.status, 'ok')
  assert.equal(serializeNotebook(parsed.notebook), golden)
  assert.equal(exports.__test.notebookCapacity(parsed.notebook).bytes, Buffer.byteLength(golden))
})

test('client preflight measures without whole-document serialization or encoding', async () => {
  const { exports } = await loadClient()
  const { notebookCapacity } = exports.__test
  const valid = notebook({ text: '中文😀\n', values: [1, null, true] })
  const expected = Buffer.byteLength(serializeNotebook(valid))
  const expanded = expandedNotebook()
  assert.ok(Buffer.byteLength(JSON.stringify(expanded)) < 2 * 1024 * 1024)
  const stringify = JSON.stringify
  const encode = TextEncoder.prototype.encode
  JSON.stringify = () => { throw new Error('preflight must not stringify') }
  TextEncoder.prototype.encode = () => { throw new Error('preflight must not encode') }
  try {
    assert.deepEqual(notebookCapacity(valid), { ok: true, bytes: expected })
    const result = notebookCapacity(expanded)
    assert.equal(result.ok, false)
    assert.ok(result.bytes > NOTEBOOK_CAP_BYTES)
    assert.throws(() => serializeNotebook(expanded), (error) => error.status === 413)
  } finally {
    JSON.stringify = stringify
    TextEncoder.prototype.encode = encode
  }
})

test('32 MiB serialized UTF-8 boundary includes the trailing newline and rejects before stringify', async () => {
  const { exports } = await loadClient()
  const result = notebook('')
  const overhead = Buffer.byteLength(serializeNotebook(result))
  result.cells[0].outputs[0].data['application/json'] = 'x'.repeat(NOTEBOOK_CAP_BYTES - overhead)
  assert.equal(exports.__test.notebookCapacity(result).bytes, NOTEBOOK_CAP_BYTES)
  assert.equal(Buffer.byteLength(serializeNotebook(result)), NOTEBOOK_CAP_BYTES)
  const withTransientId = notebook(result.cells[0].outputs[0].data['application/json'])
  withTransientId.cells[0].outputs[0].display_id = 'd'.repeat(1_000)
  assert.deepEqual(exports.__test.notebookCapacity(withTransientId), { ok: true, bytes: NOTEBOOK_CAP_BYTES },
    'transient display IDs are removed before checking the disk budget')
  const oversized = notebook(result.cells[0].outputs[0].data['application/json'] + 'x')
  const stringify = JSON.stringify
  JSON.stringify = () => { throw new Error('oversized document must not stringify') }
  try {
    assert.throws(() => serializeNotebook(oversized), (error) => error.status === 413 && error.details.size > NOTEBOOK_CAP_BYTES)
    assert.equal(exports.__test.notebookCapacity(oversized).ok, false)
  } finally {
    JSON.stringify = stringify
  }
})

test('source line expansion obeys the whole-notebook node budget before serialization', async () => {
  const { exports } = await loadClient()
  const result = notebook()
  result.cells[0].source = '\n'.repeat(NOTEBOOK_NODE_LIMIT + 1)
  const stringify = JSON.stringify
  JSON.stringify = () => { throw new Error('source expansion must not stringify') }
  try {
    assert.throws(() => serializeNotebook(result), (error) => error.status === 400)
    assert.deepEqual(exports.__test.notebookCapacity(result), { ok: false, reason: 'json-too-complex', bytes: 0 })
  } finally {
    JSON.stringify = stringify
  }
})

test('pretty expansion rejected on save preserves the original file and creates no temporary file', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'budget.ipynb')
  const original = serializeNotebook(notebook({ preserved: true }))
  await writeFile(file, original)
  const expanded = expandedNotebook()
  await assert.rejects(saveNotebookFile(file, expanded, sha256(Buffer.from(original))),
    (error) => error.status === 413 && error.code === 'too-large')
  assert.equal(await readFile(file, 'utf8'), original)
  assert.deepEqual(await readdir(dir), ['budget.ipynb'])
})
