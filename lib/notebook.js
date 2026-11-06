// Notebook parsing, normalization, versioning and atomic save for dsh-bsb-ipynb.
// Supports nbformat 4.x only (the shape Jupyter and this viewer understand).

import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { ApiError } from './json.js'

export const NOTEBOOK_CAP_BYTES = 32 * 1024 * 1024

const CELL_TYPES = new Set(['code', 'markdown', 'raw'])

export class NotebookFormatError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NotebookFormatError'
  }
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function newCellId() {
  return `cell-${randomBytes(5).toString('hex')}`
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeSource(value) {
  if (Array.isArray(value)) return value.map((line) => String(line)).join('')
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

function sourceToLines(source) {
  if (source === '') return []
  const lines = source.split(/(?<=\n)/)
  return lines
}

function normalizeOutput(output) {
  if (!isPlainObject(output)) {
    return { output_type: 'stream', name: 'stdout', text: String(output ?? '') }
  }
  switch (output.output_type) {
    case 'stream':
      return {
        ...output,
        output_type: 'stream',
        name: output.name === 'stderr' ? 'stderr' : 'stdout',
        text: normalizeSource(output.text),
      }
    case 'execute_result':
      return {
        ...output,
        output_type: 'execute_result',
        data: isPlainObject(output.data) ? output.data : {},
        metadata: isPlainObject(output.metadata) ? output.metadata : {},
        execution_count: Number.isInteger(output.execution_count) ? output.execution_count : null,
      }
    case 'display_data':
      return {
        ...output,
        output_type: 'display_data',
        data: isPlainObject(output.data) ? output.data : {},
        metadata: isPlainObject(output.metadata) ? output.metadata : {},
      }
    case 'error':
      return {
        ...output,
        output_type: 'error',
        ename: output.ename === undefined ? 'Error' : String(output.ename),
        evalue: output.evalue === undefined ? '' : String(output.evalue),
        traceback: Array.isArray(output.traceback)
          ? output.traceback.map((line) => String(line))
          : [],
      }
    default:
      return output
  }
}

function normalizeCell(cell, index) {
  if (!isPlainObject(cell)) {
    throw new Error(`Cell ${index + 1} is not a JSON object`)
  }
  const cellType = typeof cell.cell_type === 'string' ? cell.cell_type : ''
  if (!CELL_TYPES.has(cellType)) {
    throw new Error(`Cell ${index + 1} has unsupported cell_type "${cellType}"`)
  }
  const normalized = {
    ...cell,
    cell_type: cellType,
    id: typeof cell.id === 'string' && cell.id ? cell.id : newCellId(),
    metadata: isPlainObject(cell.metadata) ? cell.metadata : {},
    source: normalizeSource(cell.source),
  }
  if (cellType === 'code') {
    normalized.execution_count = Number.isInteger(cell.execution_count)
      ? cell.execution_count
      : null
    normalized.outputs = Array.isArray(cell.outputs) ? cell.outputs.map(normalizeOutput) : []
  }
  if (isPlainObject(cell.attachments)) normalized.attachments = cell.attachments
  return normalized
}

export function normalizeNotebook(notebook) {
  if (!isPlainObject(notebook)) {
    throw new Error('Notebook must be a JSON object')
  }
  if (notebook.nbformat !== undefined && notebook.nbformat !== 4) {
    throw new NotebookFormatError(
      `Unsupported nbformat ${String(notebook.nbformat)}; only nbformat 4 is supported`,
    )
  }
  if (!Array.isArray(notebook.cells)) {
    throw new Error('Notebook is missing a cells array')
  }
  const cells = notebook.cells.map(normalizeCell)
  return {
    ...notebook,
    cells,
    nbformat: 4,
    nbformat_minor: Number.isInteger(notebook.nbformat_minor) ? notebook.nbformat_minor : 5,
  }
}

export function emptyNotebook() {
  return {
    cells: [
      {
        cell_type: 'code',
        execution_count: null,
        id: newCellId(),
        metadata: {},
        outputs: [],
        source: '',
      },
    ],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }
}

export function serializeNotebook(notebook) {
  const normalized = normalizeNotebook(notebook)
  const seen = new Set()
  const cells = normalized.cells.map((cell) => {
    let id = cell.id
    while (!id || seen.has(id)) id = newCellId()
    seen.add(id)
    return { ...cell, id, source: sourceToLines(cell.source) }
  })
  const output = {
    ...normalized,
    cells,
    nbformat: 4,
    nbformat_minor: 5,
  }
  return `${JSON.stringify(output, null, 2)}\n`
}

export function parseNotebookBytes(buffer) {
  const size = buffer.length
  if (size > NOTEBOOK_CAP_BYTES) {
    throw new ApiError(
      'too-large',
      413,
      `Notebook is larger than ${Math.floor(NOTEBOOK_CAP_BYTES / 1024 / 1024)} MiB`,
      { size },
    )
  }
  const version = sha256(buffer)
  const text = buffer.toString('utf8')
  if (text.trim() === '') {
    return { status: 'ok', notebook: emptyNotebook(), version, size, emptyFile: true }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return {
      status: 'invalid',
      version,
      size,
      error: `Invalid notebook JSON: ${error.message}`,
    }
  }
  try {
    const notebook = normalizeNotebook(raw)
    return { status: 'ok', notebook, version, size, emptyFile: false }
  } catch (error) {
    if (error instanceof NotebookFormatError) {
      return { status: 'unsupported', version, size, error: error.message }
    }
    return { status: 'invalid', version, size, error: error.message }
  }
}

export async function readNotebookFile(target) {
  let stat
  try {
    stat = await fsp.stat(target)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new ApiError('not-found', 404, 'Notebook file not found')
    }
    throw new ApiError('not-found', 404, `Notebook file is not accessible: ${error.message}`)
  }
  if (!stat.isFile()) {
    throw new ApiError('not-notebook', 400, 'Notebook path is not a file')
  }
  if (stat.size > NOTEBOOK_CAP_BYTES) {
    throw new ApiError(
      'too-large',
      413,
      `Notebook is larger than ${Math.floor(NOTEBOOK_CAP_BYTES / 1024 / 1024)} MiB`,
      { size: stat.size },
    )
  }
  const buffer = await fsp.readFile(target)
  return parseNotebookBytes(buffer)
}

// Serialize saves per target path so a read-check-write inside this process
// cannot interleave with another save. External writers are still a documented
// boundary: the final rename is atomic, but not a compare-and-swap against
// processes we do not control.
const saveQueues = new Map()

function enqueueSave(target, task) {
  const previous = saveQueues.get(target) || Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.then(
    () => {},
    () => {},
  )
  saveQueues.set(target, tail)
  tail.then(() => {
    if (saveQueues.get(target) === tail) saveQueues.delete(target)
  })
  return run
}

export async function saveNotebookFile(target, notebook, baseVersion) {
  if (typeof baseVersion !== 'string' || !/^[0-9a-f]{64}$/.test(baseVersion)) {
    throw new ApiError(
      'bad-request',
      400,
      'baseVersion must be the sha256 version returned by /ipynb/read',
    )
  }
  return enqueueSave(target, () => writeNotebook(target, notebook, baseVersion))
}

async function writeNotebook(target, notebook, baseVersion) {
  let current
  try {
    current = await fsp.readFile(target)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new ApiError('write-conflict', 409, 'Notebook file no longer exists', {
        version: null,
      })
    }
    throw new ApiError('write-failed', 500, `Failed to read the notebook: ${error.message}`)
  }
  const currentVersion = sha256(current)
  if (currentVersion !== baseVersion) {
    throw new ApiError('write-conflict', 409, 'Notebook changed on disk; reload before saving', {
      version: currentVersion,
    })
  }
  const text = serializeNotebook(notebook)
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > NOTEBOOK_CAP_BYTES) {
    throw new ApiError(
      'too-large',
      413,
      `Notebook is larger than ${Math.floor(NOTEBOOK_CAP_BYTES / 1024 / 1024)} MiB`,
      { size: bytes.length },
    )
  }
  let mode = 0o644
  try {
    const stat = await fsp.stat(target)
    mode = stat.mode & 0o777
  } catch {
    // Keep the default mode; the read above already established the file.
  }
  const temporary = path.join(
    path.dirname(target),
    `.dsh-bsb-ipynb-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
  )
  try {
    await fsp.writeFile(temporary, bytes, { mode })
    await fsp.rename(temporary, target)
  } catch (error) {
    try {
      await fsp.unlink(temporary)
    } catch {
      // Ignore cleanup failures.
    }
    throw new ApiError('write-failed', 500, `Failed to write the notebook: ${error.message}`)
  }
  return { version: sha256(bytes), size: bytes.length }
}
