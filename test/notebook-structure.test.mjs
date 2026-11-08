import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  JSON_DEPTH_LIMIT,
  JSON_NODE_LIMIT,
  NOTEBOOK_CAP_BYTES,
  NOTEBOOK_NODE_LIMIT,
  normalizeNotebook,
  parseNotebookBytes,
  saveNotebookFile,
  serializeNotebook,
  sha256,
} from '../lib/notebook.js'
import { tempDir } from './python-helper.mjs'

function notebookWith(value, placement = 'display_data', mime = 'application/json') {
  const bundle = { [mime]: value }
  const cell = { cell_type: 'code', id: 'code', metadata: {}, source: '', execution_count: null, outputs: [] }
  if (placement === 'display_data' || placement === 'execute_result') {
    cell.outputs.push({ output_type: placement, data: bundle, metadata: {}, execution_count: 1 })
  } else {
    cell.cell_type = placement
    cell.attachments = { 'data.json': bundle }
  }
  return { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [cell] }
}

function nested(depth, array = false) {
  let value = null
  for (let index = 0; index < depth; index += 1) value = array ? [value] : { child: value }
  return value
}

const placements = ['display_data', 'execute_result', 'markdown', 'raw']
const mimes = ['application/json', 'application/vnd.example+json']
const structureError = (error) => error.code === 'bad-request' && error.status === 400

for (const placement of placements) {
  for (const mime of mimes) {
    test(`${placement} ${mime} enforces the JSON depth boundary`, () => {
      for (const array of [false, true]) {
        const valid = notebookWith(nested(JSON_DEPTH_LIMIT, array), placement, mime)
        assert.doesNotThrow(() => serializeNotebook(valid))
        const invalid = notebookWith(nested(JSON_DEPTH_LIMIT + 1, array), placement, mime)
        assert.throws(() => normalizeNotebook(invalid), (error) => structureError(error) && /JSON data.*maximum depth/.test(error.message))
      }
    })

    test(`${placement} ${mime} enforces the JSON node boundary`, () => {
      for (const object of [false, true]) {
        const payload = (length) => object
          ? Object.fromEntries(Array.from({ length }, (_, index) => [`item-${index}`, null]))
          : new Array(length).fill(null)
        assert.doesNotThrow(() => serializeNotebook(notebookWith(payload(JSON_NODE_LIMIT - 1), placement, mime)))
        assert.throws(
          () => normalizeNotebook(notebookWith(payload(JSON_NODE_LIMIT), placement, mime)),
          (error) => structureError(error) && /JSON data.*maximum node count/.test(error.message),
        )
      }
    })
  }
}

test('JSON payloads count shared references at every occurrence and reject cycles', () => {
  const shared = new Array((JSON_NODE_LIMIT - 2) / 2).fill(0)
  assert.throws(
    () => normalizeNotebook(notebookWith({ left: shared, right: shared })),
    (error) => structureError(error) && /maximum node count/.test(error.message),
  )
  const cyclic = {}
  cyclic.self = cyclic
  for (const placement of placements) {
    assert.throws(() => normalizeNotebook(notebookWith(cyclic, placement)), /circular structure/)
  }
  const small = { value: [1, 2, 3] }
  assert.doesNotThrow(() => serializeNotebook(notebookWith({ left: small, right: small })))
})

test('aggregate budget counts JSON MIME entries together rather than resetting per payload', () => {
  const value = new Array(JSON_NODE_LIMIT - 1).fill(0)
  const notebook = notebookWith(value)
  const data = notebook.cells[0].outputs[0].data
  for (let index = 1; index < NOTEBOOK_NODE_LIMIT / JSON_NODE_LIMIT - 1; index += 1) {
    data[`application/vnd.example-${index}+json`] = value
  }
  assert.doesNotThrow(() => normalizeNotebook(notebook))
  data['application/vnd.final+json'] = value
  assert.throws(() => normalizeNotebook(notebook), (error) => structureError(error) && /Notebook.*maximum node count/.test(error.message))
})

test('aggregate budget is shared across cells, output metadata and attachments', () => {
  const metadata = { values: new Array(JSON_NODE_LIMIT - 2).fill(0) }
  const value = new Array(JSON_NODE_LIMIT - 1).fill(0)
  const notebook = notebookWith(value)
  notebook.metadata = metadata
  notebook.cells[0].metadata = metadata
  notebook.cells[0].outputs[0].metadata = metadata
  for (let index = 4; index < NOTEBOOK_NODE_LIMIT / JSON_NODE_LIMIT - 1; index += 1) {
    const cell = notebookWith(value, index % 2 ? 'markdown' : 'execute_result').cells[0]
    cell.id = `cell-${index}`
    notebook.cells.push(cell)
  }
  assert.doesNotThrow(() => normalizeNotebook(notebook))
  notebook.cells.push(notebookWith(value, 'raw').cells[0])
  assert.throws(() => normalizeNotebook(notebook), (error) => structureError(error) && /Notebook.*maximum node count/.test(error.message))
})

test('aggregate budget includes schema containers and non-JSON multiline values at the exact boundary', () => {
  // This normalized fixture has 17 nodes besides the multiline array's items.
  const lines = new Array(NOTEBOOK_NODE_LIMIT - 17).fill('')
  const notebook = notebookWith(lines, 'display_data', 'text/plain')
  assert.doesNotThrow(() => normalizeNotebook(notebook))
  lines.push('')
  assert.throws(() => normalizeNotebook(notebook), (error) => structureError(error) && /Notebook.*maximum node count/.test(error.message))
})

test('aggregate budget rejects oversized output and cell lists while projecting', () => {
  const notebook = notebookWith(null)
  const stream = { output_type: 'stream', name: 'stdout', text: '' }
  notebook.cells[0].outputs = new Array(NOTEBOOK_NODE_LIMIT / 4).fill(stream)
  assert.throws(() => normalizeNotebook(notebook), (error) => structureError(error) && /Notebook.*maximum node count/.test(error.message))
  const cell = notebookWith(null, 'raw').cells[0]
  delete cell.attachments
  notebook.cells = new Array(NOTEBOOK_NODE_LIMIT / 5).fill(cell)
  assert.throws(() => normalizeNotebook(notebook), (error) => structureError(error) && /Notebook.*maximum node count/.test(error.message))
})

test('discarded unknown fields and invalid MIME representations do not consume the retained JSON budget', () => {
  const ignored = nested(JSON_DEPTH_LIMIT + 20)
  const notebook = notebookWith({ ok: true })
  notebook.extra = ignored
  notebook.cells[0].extra = ignored
  notebook.cells[0].attachments = { ignored: { 'application/json': ignored } }
  notebook.cells[0].outputs[0].extra = ignored
  notebook.cells[0].outputs[0].data['text/plain'] = ignored
  assert.doesNotThrow(() => normalizeNotebook(notebook))
})

test('source and traceback arrays are bounded before their converted copies are allocated', () => {
  const notebook = notebookWith(null)
  notebook.cells[0].source = new Array(NOTEBOOK_NODE_LIMIT + 1).fill('')
  assert.throws(() => normalizeNotebook(notebook), structureError)
  notebook.cells[0].source = ['x'.repeat(NOTEBOOK_CAP_BYTES), 'x']
  assert.throws(() => normalizeNotebook(notebook), (error) => error.code === 'too-large' && error.status === 413)
  notebook.cells[0].source = ''
  notebook.cells[0].outputs = [{ output_type: 'error', traceback: new Array(NOTEBOOK_NODE_LIMIT).fill('') }]
  assert.throws(() => normalizeNotebook(notebook), structureError)
})

test('source and stream character budgets are shared and reject before the overflowing join', () => {
  const chunk = 'x'.repeat(NOTEBOOK_CAP_BYTES / 2)
  for (const placement of ['cell', 'stream', 'string-source']) {
    const notebook = notebookWith(null)
    notebook.cells[0].source = placement === 'string-source' ? chunk : [chunk]
    if (placement === 'cell') {
      const next = notebookWith(null).cells[0]
      next.source = [chunk, 'x']
      notebook.cells.push(next)
    } else {
      notebook.cells[0].outputs = [{ output_type: 'stream', name: 'stdout', text: [chunk, 'x'] }]
    }
    const originalJoin = Array.prototype.join
    let joins = 0
    let failure
    try {
      Array.prototype.join = function (...args) {
        joins += 1
        return Reflect.apply(originalJoin, this, args)
      }
      normalizeNotebook(notebook)
    } catch (error) {
      failure = error
    } finally {
      Array.prototype.join = originalJoin
    }
    assert.equal(failure?.code, 'too-large', placement)
    assert.equal(failure.status, 413)
    assert.equal(joins, placement === 'string-source' ? 0 : 1, 'only the earlier in-budget source may be joined')
  }
})

test('over-limit JSON data is reported as invalid on read with the original byte version', () => {
  for (const placement of placements) {
    for (const mime of mimes) {
      for (const value of [nested(JSON_DEPTH_LIMIT + 1), new Array(JSON_NODE_LIMIT).fill(0)]) {
        const bytes = Buffer.from(JSON.stringify(notebookWith(value, placement, mime)))
        const result = parseNotebookBytes(bytes)
        assert.equal(result.status, 'invalid')
        assert.equal(result.version, sha256(bytes))
        assert.equal(result.size, bytes.length)
        assert.match(result.error, /JSON data.*maximum (depth|node count)/)
        assert.equal(result.notebook, undefined)
      }
    }
  }
})

test('failed JSON structure saves leave the existing notebook and directory unchanged', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'structure.ipynb')
  const original = serializeNotebook(notebookWith({ valid: true }))
  await writeFile(file, original)
  const version = sha256(Buffer.from(original))
  for (const placement of placements) {
    for (const value of [nested(JSON_DEPTH_LIMIT + 1), new Array(JSON_NODE_LIMIT).fill(0)]) {
      await assert.rejects(saveNotebookFile(file, notebookWith(value, placement), version), structureError)
      assert.equal(await readFile(file, 'utf8'), original)
      assert.deepEqual(await readdir(dir), ['structure.ipynb'])
    }
  }
  const cyclic = {}
  cyclic.self = cyclic
  await assert.rejects(saveNotebookFile(file, notebookWith(cyclic), version), (error) => structureError(error) && /circular/.test(error.message))
  assert.equal(await readFile(file, 'utf8'), original)
  assert.deepEqual(await readdir(dir), ['structure.ipynb'])
})
