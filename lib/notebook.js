// Notebook parsing, normalization, versioning and atomic save for dsh-bsb-ipynb.
// Supports nbformat 4.x only (the shape Jupyter and this viewer understand).

import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { ApiError } from './json.js'

export const NOTEBOOK_CAP_BYTES = 32 * 1024 * 1024
export const METADATA_DEPTH_LIMIT = 100
export const METADATA_NODE_LIMIT = 10_000

// Fixed chunk size for bounded notebook reads. Reads stop as soon as the file
// (or its growth) exceeds the cap, so no single read can be unbounded.
const READ_CHUNK_BYTES = 64 * 1024

const CELL_TYPES = new Set(['code', 'markdown', 'raw'])
// nbformat 4.5 `cell_id` pattern (hyphen kept last so the class is unambiguous).
const CELL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
// nbformat 4.5 permits arbitrary JSON values only for these MIME keys.
const JSON_MIME_PATTERN = /^application\/(.*\+)?json$/

export class NotebookFormatError extends ApiError {
  constructor(message) {
    super('bad-request', 400, message)
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

function assertMetadataWithinLimits(metadata, label) {
  // Pretty-printed indentation grows quadratically with nesting depth. Walk
  // iteratively so validation itself cannot overflow the call stack. Repeated
  // references count as repeated JSON output; only active ancestors are cycles.
  const ancestors = new WeakSet()
  const stack = [{ value: metadata, depth: 0, exit: false }]
  let nodes = 0
  while (stack.length) {
    const frame = stack.pop()
    if (frame.exit) {
      ancestors.delete(frame.value)
      continue
    }
    nodes += 1
    if (nodes > METADATA_NODE_LIMIT) {
      throw new ApiError('bad-request', 400, `${label} exceeds the maximum node count of ${METADATA_NODE_LIMIT}`)
    }
    if (frame.depth > METADATA_DEPTH_LIMIT) {
      throw new ApiError('bad-request', 400, `${label} exceeds the maximum depth of ${METADATA_DEPTH_LIMIT}`)
    }
    const value = frame.value
    if (!value || typeof value !== 'object') continue
    if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON')
    ancestors.add(value)
    stack.push({ value, depth: frame.depth, exit: true })
    const children = Array.isArray(value) ? value : Object.values(value)
    // Every child counts as at least one more node; reject an over-wide object
    // before materializing one stack frame per child.
    if (children.length > METADATA_NODE_LIMIT - nodes) {
      throw new ApiError('bad-request', 400, `${label} exceeds the maximum node count of ${METADATA_NODE_LIMIT}`)
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: frame.depth + 1, exit: false })
    }
  }
}

function normalizeMetadata(value, label) {
  const metadata = isPlainObject(value) ? value : {}
  assertMetadataWithinLimits(metadata, label)
  return metadata
}

function normalizeSource(value) {
  if (Array.isArray(value)) return value.map((line) => String(line)).join('')
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

function sourceToLines(source) {
  if (source === '') return []
  // Avoid lookbehind syntax (older Safari cannot parse it): each line keeps its
  // trailing newline, exactly like split(/(?<=\n)/).
  const lines = []
  let start = 0
  for (;;) {
    const index = source.indexOf('\n', start)
    if (index === -1) {
      if (start < source.length) lines.push(source.slice(start))
      break
    }
    lines.push(source.slice(start, index + 1))
    start = index + 1
  }
  return lines
}

function normalizeExecutionCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

function isMultilineString(value) {
  if (typeof value === 'string') return true
  if (!Array.isArray(value)) return false
  for (const line of value) {
    if (typeof line !== 'string') return false
  }
  return true
}

function normalizeMimeBundle(bundle) {
  if (!isPlainObject(bundle)) return {}
  // Drop invalid representations without coercing objects to text or removing
  // valid JSON outputs. Empty bundles and unknown MIME keys with text are legal.
  return Object.fromEntries(Object.entries(bundle).filter(([mime, value]) =>
    JSON_MIME_PATTERN.test(mime) || isMultilineString(value),
  ))
}

function normalizeAttachments(attachments) {
  return Object.fromEntries(Object.entries(attachments)
    .filter(([, bundle]) => isPlainObject(bundle))
    .map(([name, bundle]) => [name, normalizeMimeBundle(bundle)]))
}

// Project an output onto the fields nbformat 4 allows for its output_type.
// Unknown keys are dropped instead of forwarded: clients only need to render
// the schema fields, and the save path must not persist illegal data (for
// example display_data.execution_count/display_id written by some frontends).
function normalizeOutput(output) {
  if (!isPlainObject(output)) {
    return { output_type: 'stream', name: 'stdout', text: String(output ?? '') }
  }
  switch (output.output_type) {
    case 'stream':
      return {
        output_type: 'stream',
        name: output.name === 'stderr' ? 'stderr' : 'stdout',
        text: normalizeSource(output.text),
      }
    case 'execute_result':
      return {
        output_type: 'execute_result',
        data: normalizeMimeBundle(output.data),
        metadata: normalizeMetadata(output.metadata, 'Output metadata'),
        execution_count: normalizeExecutionCount(output.execution_count),
      }
    case 'display_data':
      return {
        output_type: 'display_data',
        data: normalizeMimeBundle(output.data),
        metadata: normalizeMetadata(output.metadata, 'Output metadata'),
      }
    case 'error':
      return {
        output_type: 'error',
        ename: output.ename === undefined ? 'Error' : String(output.ename),
        evalue: output.evalue === undefined ? '' : String(output.evalue),
        traceback: Array.isArray(output.traceback)
          ? output.traceback.map((line) => String(line))
          : [],
      }
    default:
      // Not an nbformat output type: drop it rather than persisting junk.
      return null
  }
}

function normalizeOutputs(outputs) {
  if (!Array.isArray(outputs)) return []
  const normalized = []
  for (const output of outputs) {
    const clean = normalizeOutput(output)
    if (clean) normalized.push(clean)
  }
  return normalized
}

function normalizeCell(cell, index) {
  if (!isPlainObject(cell)) {
    throw new ApiError('bad-request', 400, `Cell ${index + 1} is not a JSON object`)
  }
  const cellType = typeof cell.cell_type === 'string' ? cell.cell_type : ''
  if (!CELL_TYPES.has(cellType)) {
    throw new ApiError(
      'bad-request',
      400,
      `Cell ${index + 1} has unsupported cell_type "${cellType}"`,
    )
  }
  const id =
    typeof cell.id === 'string' && CELL_ID_PATTERN.test(cell.id) ? cell.id : newCellId()
  const metadata = normalizeMetadata(cell.metadata, `Cell ${index + 1} metadata`)
  const source = normalizeSource(cell.source)
  if (cellType === 'code') {
    return {
      cell_type: cellType,
      execution_count: normalizeExecutionCount(cell.execution_count),
      id,
      metadata,
      outputs: normalizeOutputs(cell.outputs),
      source,
    }
  }
  // markdown/raw cells have no outputs or execution_count; attachments only
  // apply to those two cell types.
  const normalized = { cell_type: cellType, id, metadata, source }
  if (isPlainObject(cell.attachments)) {
    normalized.attachments = normalizeAttachments(cell.attachments)
  }
  return normalized
}

export function normalizeNotebook(notebook) {
  if (!isPlainObject(notebook)) {
    throw new ApiError('bad-request', 400, 'Notebook must be a JSON object')
  }
  if (notebook.nbformat !== undefined && notebook.nbformat !== 4) {
    throw new NotebookFormatError(
      `Unsupported nbformat ${String(notebook.nbformat)}; only nbformat 4 is supported`,
    )
  }
  if (!Array.isArray(notebook.cells)) {
    throw new ApiError('bad-request', 400, 'Notebook is missing a cells array')
  }
  const cells = notebook.cells.map(normalizeCell)
  // Only the four top-level nbformat 4 fields are kept.
  return {
    cells,
    metadata: normalizeMetadata(notebook.metadata, 'Notebook metadata'),
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
    cells,
    metadata: normalized.metadata,
    nbformat: 4,
    nbformat_minor: 5,
  }
  return `${JSON.stringify(output, null, 2)}\n`
}

// Windows editors (notably PowerShell 5.1's Out-File) prepend a byte-order
// mark. Decode it before JSON.parse so a valid notebook is not reported as
// invalid just because of the encoding header.
function decodeNotebookText(buffer) {
  let encoding = 'utf-8'
  let bytes = buffer
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    bytes = buffer.subarray(3)
  } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = 'utf-16le'
    bytes = buffer.subarray(2)
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = 'utf-16be'
    bytes = buffer.subarray(2)
  }
  return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes)
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
  let text
  try {
    text = decodeNotebookText(buffer)
  } catch (error) {
    return {
      status: 'invalid',
      version,
      size,
      error: `Invalid notebook encoding: ${error.message}`,
    }
  }
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

// A read that fails because another process holds the file should be a clear,
// retryable error instead of an internal 500.
export function readFailureReason(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return code === 'EBUSY' ? 'locked' : 'blocked'
  }
  return null
}

// The read response must be a valid nbformat 4.5 notebook even when the file on
// disk is not: unique cell ids and nbformat_minor >= 5 once those ids exist.
function normalizeReadableNotebook(notebook) {
  const seen = new Set()
  let changed = false
  const cells = notebook.cells.map((cell) => {
    if (typeof cell.id === 'string' && cell.id && !seen.has(cell.id)) {
      seen.add(cell.id)
      return cell
    }
    changed = true
    let id = newCellId()
    while (seen.has(id)) id = newCellId()
    seen.add(id)
    return { ...cell, id }
  })
  const minor = Number.isInteger(notebook.nbformat_minor) ? notebook.nbformat_minor : 4
  if (!changed && minor >= 5) return notebook
  return { ...notebook, cells, nbformat_minor: Math.max(5, minor) }
}

function notebookAccessError(error) {
  if (error && error.code === 'ENOENT') {
    return new ApiError('not-found', 404, 'Notebook file not found')
  }
  const reason = readFailureReason(error)
  if (reason) {
    return new ApiError(
      'read-blocked',
      409,
      reason === 'locked'
        ? 'The notebook file is in use or not readable; close other programs and retry'
        : 'The notebook file is not readable; check its permissions',
      { reason },
    )
  }
  return null
}

function tooLargeError(size) {
  return new ApiError(
    'too-large',
    413,
    `Notebook is larger than ${Math.floor(NOTEBOOK_CAP_BYTES / 1024 / 1024)} MiB`,
    { size },
  )
}

// Open a notebook, verify on the opened handle that it is still a regular file
// within the cap, then read at most NOTEBOOK_CAP_BYTES + 1 bytes in fixed-size
// chunks. The read route and the save-time version checks share this, so a file
// that grows between the authorization stat and the actual I/O can never be
// buffered whole (M-15); the growth is reported as 413 instead of a 409.
// Access errors are re-thrown raw so each caller keeps its own error mapping
// (404 for reads, 409 for saves). Exported for tests, which exercise the
// bounded read directly.
export async function readBoundedNotebookFile(target) {
  const handle = await fsp.open(target, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) {
      throw new ApiError('not-notebook', 400, 'Notebook path is not a file')
    }
    if (opened.size > NOTEBOOK_CAP_BYTES) throw tooLargeError(opened.size)
    const chunks = []
    let total = 0
    while (total <= NOTEBOOK_CAP_BYTES) {
      const size = Math.min(READ_CHUNK_BYTES, NOTEBOOK_CAP_BYTES + 1 - total)
      if (size <= 0) break
      const buffer = Buffer.allocUnsafe(size)
      const { bytesRead } = await handle.read(buffer, 0, size, total)
      if (bytesRead === 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      total += bytesRead
    }
    if (total > NOTEBOOK_CAP_BYTES) throw tooLargeError(total)
    return Buffer.concat(chunks, total)
  } finally {
    try {
      await handle.close()
    } catch {
      // Ignore close failures.
    }
  }
}

export async function readNotebookFile(target) {
  let stat
  try {
    stat = await fsp.stat(target)
  } catch (error) {
    const mapped = notebookAccessError(error)
    if (mapped) throw mapped
    // Do not leak absolute paths or OS error text into the API response.
    throw new ApiError('not-found', 404, 'Notebook file is not accessible', {
      reason: (error && error.code) || 'error',
    })
  }
  if (!stat.isFile()) {
    throw new ApiError('not-notebook', 400, 'Notebook path is not a file')
  }
  if (stat.size > NOTEBOOK_CAP_BYTES) throw tooLargeError(stat.size)
  try {
    const parsed = parseNotebookBytes(await readBoundedNotebookFile(target))
    if (parsed.status !== 'ok') return parsed
    return { ...parsed, notebook: normalizeReadableNotebook(parsed.notebook) }
  } catch (error) {
    if (error instanceof ApiError) throw error
    const mapped = notebookAccessError(error)
    if (mapped) throw mapped
    console.error('[dsh-bsb-ipynb] notebook read failed:', error)
    throw new ApiError('not-found', 404, 'Notebook file is not accessible')
  }
}

// A crashed save can leave a `.dsh-bsb-ipynb-*.tmp` behind. Sweep old ones
// (once per directory per few minutes) instead of accumulating them forever.
const TEMP_FILE_PATTERN = /^\.dsh-bsb-ipynb-\d+-[0-9a-f]+\.tmp$/
const TEMP_SWEEP_INTERVAL_MS = 5 * 60 * 1000
const TEMP_STALE_MS = 60 * 60 * 1000
const tempSweeps = new Map()

async function sweepStaleTemps(directory) {
  const now = Date.now()
  if (now - (tempSweeps.get(directory) || 0) < TEMP_SWEEP_INTERVAL_MS) return
  if (tempSweeps.size > 1024) tempSweeps.clear()
  tempSweeps.set(directory, now)
  let names
  try {
    names = await fsp.readdir(directory)
  } catch {
    return
  }
  for (const name of names) {
    if (!TEMP_FILE_PATTERN.test(name)) continue
    const file = path.join(directory, name)
    try {
      const fileStat = await fsp.stat(file)
      if (now - fileStat.mtimeMs > TEMP_STALE_MS) await fsp.unlink(file)
    } catch {
      // Best effort: a locked temp file is removed on a later sweep.
    }
  }
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

// A read-only target or a file held open by another program surfaces as
// EPERM/EACCES/EBUSY on rename (Windows) or EROFS on a read-only filesystem.
// These are user-actionable, so report a retryable write-blocked error instead
// of an internal write failure.
const BLOCKED_SAVE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EROFS'])

// Exported for tests: maps a filesystem error onto the retryable reason.
export function saveFailureReason(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (!BLOCKED_SAVE_CODES.has(code)) return null
  return code === 'EBUSY' ? 'locked' : 'blocked'
}

async function blockedSaveError(error, target) {
  const reason = saveFailureReason(error)
  if (!reason) return null
  let readOnly = error.code === 'EROFS'
  if (!readOnly) {
    try {
      const current = await fsp.stat(target)
      readOnly = (current.mode & 0o200) === 0
    } catch {
      // Keep the retryable classification even if the target disappeared.
    }
  }
  const message = readOnly
    ? 'The notebook file is read-only; clear the read-only attribute and save again'
    : 'The notebook file is in use or not writable; close other programs and save again'
  return new ApiError('write-blocked', 409, message, { reason: readOnly ? 'readonly' : 'locked' })
}

async function assertNotebookVersion(target, baseVersion) {
  let current
  try {
    // Bound the read: the file can grow past the cap between the caller's stat
    // and this version check, and buffering a huge file is not needed to detect
    // the conflict. Growth is a 413, never a 409 (M-15).
    current = await readBoundedNotebookFile(target)
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error && error.code === 'ENOENT') {
      throw new ApiError('write-conflict', 409, 'Notebook file no longer exists', {
        version: null,
      })
    }
    const blocked = await blockedSaveError(error, target)
    if (blocked) throw blocked
    // Keep absolute paths and temp names out of the API response.
    console.error('[dsh-bsb-ipynb] notebook read failed while saving:', error)
    throw new ApiError('write-failed', 500, 'Failed to read the notebook')
  }
  const currentVersion = sha256(current)
  if (currentVersion !== baseVersion) {
    throw new ApiError('write-conflict', 409, 'Notebook changed on disk; reload before saving', {
      version: currentVersion,
    })
  }
}

async function writeNotebook(target, notebook, baseVersion) {
  // Serialize first: a malformed client notebook is a bad request even when
  // the on-disk version is also stale, so the client is told to fix its payload
  // rather than to reload. The disk file is still stat'ed before being read so
  // an oversized file is refused without buffering it into memory.
  let text
  try {
    text = serializeNotebook(notebook)
  } catch (error) {
    // The pretty-printed form can outgrow the engine's maximum string length
    // for pathological but otherwise valid notebooks (deep JSON data values).
    // That is still a size problem, not an internal error.
    if (error instanceof RangeError) {
      throw new ApiError('too-large', 413, 'Notebook is too large to serialize')
    }
    // A circular metadata reference is a malformed client notebook, not an
    // internal failure (JSON bodies cannot carry one, but internal callers can).
    if (error instanceof TypeError && /circular/i.test(error.message)) {
      throw new ApiError('bad-request', 400, 'Notebook metadata contains a circular reference')
    }
    throw error
  }
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > NOTEBOOK_CAP_BYTES) {
    throw new ApiError(
      'too-large',
      413,
      `Notebook is larger than ${Math.floor(NOTEBOOK_CAP_BYTES / 1024 / 1024)} MiB`,
      { size: bytes.length },
    )
  }
  let stat
  try {
    stat = await fsp.stat(target)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new ApiError('write-conflict', 409, 'Notebook file no longer exists', {
        version: null,
      })
    }
    const blocked = await blockedSaveError(error, target)
    if (blocked) throw blocked
    console.error('[dsh-bsb-ipynb] notebook stat failed while saving:', error)
    throw new ApiError('write-failed', 500, 'Failed to read the notebook')
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
  await assertNotebookVersion(target, baseVersion)
  // Windows only exposes a read-only bit through chmod; copying a POSIX mode
  // has no effect there and can leave the temp file read-only, so preserve the
  // permission bits on POSIX only.
  const preserveMode = process.platform !== 'win32'
  const mode = stat.mode & 0o777
  const temporary = path.join(
    path.dirname(target),
    `.dsh-bsb-ipynb-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
  )
  try {
    await fsp.writeFile(temporary, bytes, preserveMode ? { mode } : undefined)
    // The mode passed to writeFile is filtered through umask. Preserve the
    // permission bits of the file being replaced before the atomic rename.
    if (preserveMode) await fsp.chmod(temporary, mode)
    // An external writer may have changed the target while the temporary file
    // was being written. Refuse to overwrite that change. This second check
    // narrows the race, but the final rename is still not a cross-process CAS.
    await assertNotebookVersion(target, baseVersion)
    await fsp.rename(temporary, target)
  } catch (error) {
    try {
      await fsp.unlink(temporary)
    } catch {
      // Ignore cleanup failures.
    }
    if (error instanceof ApiError) throw error
    const blocked = await blockedSaveError(error, target)
    if (blocked) throw blocked
    // Keep the absolute path, temp name and PID out of the API response; the
    // server log keeps the diagnostics.
    console.error('[dsh-bsb-ipynb] notebook write failed:', error)
    throw new ApiError('write-failed', 500, 'Failed to write the notebook')
  }
  await sweepStaleTemps(path.dirname(target))
  return { version: sha256(bytes), size: bytes.length }
}
