import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
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
