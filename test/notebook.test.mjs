import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, readdir, truncate } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  NOTEBOOK_CAP_BYTES,
  emptyNotebook,
  normalizeNotebook,
  parseNotebookBytes,
  readNotebookFile,
  saveNotebookFile,
  serializeNotebook,
  sha256,
} from '../lib/notebook.js'
import { errorPayload } from '../lib/json.js'

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'dsh-bsb-ipynb-test-'))
}

test('empty notebook is nbformat 4.5 with one code cell', () => {
  const notebook = emptyNotebook()
  assert.equal(notebook.nbformat, 4)
  assert.equal(notebook.nbformat_minor, 5)
  assert.equal(notebook.cells.length, 1)
  assert.equal(notebook.cells[0].cell_type, 'code')
  assert.deepEqual(notebook.cells[0].outputs, [])
  assert.match(notebook.metadata.kernelspec.name, /python/)
})

test('serialize produces source line arrays and round-trips', () => {
  const notebook = emptyNotebook()
  notebook.cells[0].source = 'print(1)\nprint(2)'
  notebook.cells.push({
    cell_type: 'markdown',
    id: 'cell-md',
    metadata: {},
    source: '# Title\n\nText',
  })
  const text = serializeNotebook(notebook)
  const raw = JSON.parse(text)
  assert.deepEqual(raw.cells[0].source, ['print(1)\n', 'print(2)'])
  assert.equal(text.endsWith('\n'), true)
  const parsed = parseNotebookBytes(Buffer.from(text))
  assert.equal(parsed.status, 'ok')
  assert.equal(parsed.notebook.cells[0].source, 'print(1)\nprint(2)')
  assert.equal(parsed.notebook.cells[1].cell_type, 'markdown')
})

test('source ending in a newline keeps the empty final line', () => {
  const notebook = emptyNotebook()
  notebook.cells[0].source = 'x\n'
  const raw = JSON.parse(serializeNotebook(notebook))
  assert.deepEqual(raw.cells[0].source, ['x\n'])
})

test('normalize accepts string arrays and generates missing ids', () => {
  const notebook = normalizeNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    cells: [{ cell_type: 'code', source: ['a', 'b'], outputs: [], metadata: {} }],
    metadata: {},
  })
  assert.equal(notebook.cells[0].source, 'ab')
  assert.match(notebook.cells[0].id, /^cell-/)
})

test('invalid JSON returns status invalid without throwing', () => {
  const result = parseNotebookBytes(Buffer.from('{not json'))
  assert.equal(result.status, 'invalid')
  assert.equal(result.version.length, 64)
  assert.match(result.error, /Invalid notebook JSON/)
})

test('non nbformat 4 returns unsupported', () => {
  const result = parseNotebookBytes(
    Buffer.from(JSON.stringify({ nbformat: 3, cells: [], metadata: {} })),
  )
  assert.equal(result.status, 'unsupported')
})

test('missing cells array returns invalid', () => {
  const result = parseNotebookBytes(Buffer.from(JSON.stringify({ nbformat: 4 })))
  assert.equal(result.status, 'invalid')
})

test('empty and whitespace-only files become empty notebooks', () => {
  for (const text of ['', '  \n\t ']) {
    const result = parseNotebookBytes(Buffer.from(text))
    assert.equal(result.status, 'ok')
    assert.equal(result.emptyFile, true)
    assert.equal(result.notebook.cells.length, 1)
  }
})

test('too-large notebooks are rejected', () => {
  const buffer = Buffer.alloc(NOTEBOOK_CAP_BYTES + 1, 0x20)
  assert.throws(() => parseNotebookBytes(buffer), (error) => error.code === 'too-large')
})

test('readNotebookFile reads real files', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'demo.ipynb')
  const text = serializeNotebook(emptyNotebook())
  await writeFile(file, text)
  const result = await readNotebookFile(file)
  assert.equal(result.status, 'ok')
  assert.equal(result.version, sha256(Buffer.from(text)))
})

test('saveNotebookFile writes atomically and changes the version', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'demo.ipynb')
  const original = serializeNotebook(emptyNotebook())
  await writeFile(file, original)
  const read = await readNotebookFile(file)
  read.notebook.cells[0].source = 'print("saved")'
  const saved = await saveNotebookFile(file, read.notebook, read.version)
  assert.equal(saved.version, sha256(await readFile(file)))
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(onDisk.cells[0].source, ['print("saved")'])
  const entries = await readdir(dir)
  assert.deepEqual(entries, ['demo.ipynb'])
})

test('concurrent saves with the same baseVersion conflict instead of overwriting', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'demo.ipynb')
  await writeFile(file, serializeNotebook(emptyNotebook()))
  const read = await readNotebookFile(file)
  const first = JSON.parse(JSON.stringify(read.notebook))
  const second = JSON.parse(JSON.stringify(read.notebook))
  first.cells[0].source = 'first'
  second.cells[0].source = 'second'
  const results = await Promise.allSettled([
    saveNotebookFile(file, first, read.version),
    saveNotebookFile(file, second, read.version),
  ])
  const fulfilled = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason.code, 'write-conflict')
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.ok(['first', 'second'].includes(onDisk.cells[0].source[0]))
  const entries = await readdir(dir)
  assert.deepEqual(entries, ['demo.ipynb'])
})

test('saveNotebookFile rejects a stale baseVersion', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'demo.ipynb')
  await writeFile(file, serializeNotebook(emptyNotebook()))
  const read = await readNotebookFile(file)
  await writeFile(file, serializeNotebook(emptyNotebook()))
  read.notebook.cells[0].source = '1 + 1'
  await assert.rejects(
    saveNotebookFile(file, read.notebook, read.version),
    (error) => error.code === 'write-conflict' && error.status === 409,
  )
})

test('saveNotebookFile requires a valid baseVersion', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'demo.ipynb')
  await writeFile(file, serializeNotebook(emptyNotebook()))
  await assert.rejects(
    saveNotebookFile(file, emptyNotebook(), 'not-a-version'),
    (error) => error.code === 'bad-request',
  )
})

test('saveNotebookFile maps malformed notebooks to bad-request', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'demo.ipynb')
  const original = serializeNotebook(emptyNotebook())
  await writeFile(file, original)
  const read = await readNotebookFile(file)
  const malformed = [
    null,
    { nbformat: 4 },
    { nbformat: 4, cells: [{ cell_type: 'invalid' }] },
    { nbformat: 3, cells: [] },
  ]
  for (const notebook of malformed) {
    await assert.rejects(
      saveNotebookFile(file, notebook, read.version),
      (error) => error.code === 'bad-request' && error.status === 400,
    )
  }
  assert.equal(await readFile(file, 'utf8'), original)
})

test('saveNotebookFile leaves unexpected serialization errors as internal failures', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'demo.ipynb')
  const original = serializeNotebook(emptyNotebook())
  await writeFile(file, original)
  const read = await readNotebookFile(file)
  const notebook = emptyNotebook()
  notebook.metadata.circular = notebook.metadata
  await assert.rejects(saveNotebookFile(file, notebook, read.version), (error) => {
    assert.equal(errorPayload(error).status, 500)
    return true
  })
  assert.equal(await readFile(file, 'utf8'), original)
  assert.deepEqual(await readdir(dir), ['demo.ipynb'])
})

test('normalize drops fields that nbformat does not allow', () => {
  const notebook = normalizeNotebook({
    extra_top_level: 'drop',
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3' } },
    cells: [
      {
        cell_type: 'code',
        id: 'code-cell',
        metadata: {},
        source: 'print(1)',
        execution_count: 1,
        attachments: { 'x.txt': { 'text/plain': 'x' } },
        extra_cell: true,
        outputs: [
          { output_type: 'stream', name: 'stderr', text: 'oops\n', extra: 1 },
          {
            output_type: 'execute_result',
            data: { 'text/plain': '1' },
            metadata: {},
            execution_count: 1,
            extra: 1,
          },
          {
            output_type: 'display_data',
            data: { 'text/plain': 'plot' },
            metadata: {},
            execution_count: null,
            display_id: 'd1',
            extra: 1,
          },
          {
            output_type: 'error',
            ename: 'ValueError',
            evalue: 'bad',
            traceback: ['tb'],
            extra: 1,
          },
          { output_type: 'mystery', data: {} },
        ],
      },
      {
        cell_type: 'markdown',
        id: 'md-cell',
        metadata: {},
        source: '# hi',
        attachments: { 'a.txt': { 'text/plain': 'a' } },
        outputs: [],
        execution_count: 2,
        extra: 1,
      },
      { cell_type: 'raw', id: 'raw-cell', metadata: {}, source: 'raw', outputs: [] },
    ],
  })
  assert.deepEqual(Object.keys(notebook).sort(), ['cells', 'metadata', 'nbformat', 'nbformat_minor'])
  const [code, markdown, raw] = notebook.cells
  assert.deepEqual(Object.keys(code).sort(), [
    'cell_type',
    'execution_count',
    'id',
    'metadata',
    'outputs',
    'source',
  ])
  assert.equal(code.attachments, undefined)
  assert.equal(code.extra_cell, undefined)
  assert.equal(code.outputs.length, 4, 'unknown output_type is dropped')
  assert.deepEqual(Object.keys(code.outputs[0]).sort(), ['name', 'output_type', 'text'])
  assert.deepEqual(Object.keys(code.outputs[1]).sort(), [
    'data',
    'execution_count',
    'metadata',
    'output_type',
  ])
  assert.equal(code.outputs[1].execution_count, 1)
  assert.deepEqual(Object.keys(code.outputs[2]).sort(), ['data', 'metadata', 'output_type'])
  assert.equal(code.outputs[2].display_id, undefined)
  assert.equal(code.outputs[2].execution_count, undefined)
  assert.deepEqual(Object.keys(code.outputs[3]).sort(), [
    'ename',
    'evalue',
    'output_type',
    'traceback',
  ])
  assert.deepEqual(Object.keys(markdown).sort(), [
    'attachments',
    'cell_type',
    'id',
    'metadata',
    'source',
  ])
  assert.deepEqual(Object.keys(raw).sort(), ['cell_type', 'id', 'metadata', 'source'])
})

test('examples/demo.ipynb serializes to an nbformat-legal notebook', async () => {
  const file = new URL('../examples/demo.ipynb', import.meta.url)
  const raw = JSON.parse(await readFile(file, 'utf8'))
  const serialized = serializeNotebook(raw)
  const parsed = JSON.parse(serialized)
  assert.equal(parsed.nbformat, 4)
  assert.equal(parsed.nbformat_minor, 5)
  for (const cell of parsed.cells) {
    assert.ok(['code', 'markdown', 'raw'].includes(cell.cell_type))
    if (cell.cell_type !== 'code') continue
    for (const output of cell.outputs) {
      if (output.output_type === 'display_data') {
        assert.deepEqual(Object.keys(output).sort(), ['data', 'metadata', 'output_type'])
      }
    }
  }
  // The historical fixture bug: a display_data output carried execution_count.
  assert.equal(parsed.cells[6].outputs[0].execution_count, undefined)
})

test('saveNotebookFile caps the on-disk file before reading it', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'demo.ipynb')
  await writeFile(file, '{}')
  await truncate(file, NOTEBOOK_CAP_BYTES + 1)
  await assert.rejects(
    saveNotebookFile(file, emptyNotebook(), '0'.repeat(64)),
    (error) =>
      error.code === 'too-large' &&
      error.status === 413 &&
      error.details.size === NOTEBOOK_CAP_BYTES + 1,
  )
})
