// Python interpreter discovery for dsh-bsb-ipynb.
//
// A candidate is only usable when it can import both jupyter_client and
// ipykernel. The DSH-bundled Python is intentionally probed too, but it is
// usually reported as unusable because it ships without those packages.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants as fsConstants } from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiError } from './json.js'

const CACHE_TTL_MS = 60_000
const PROBE_TIMEOUT_MS = 5_000
const HINT = 'Install the Python kernel packages, e.g. `python -m pip install jupyter_client ipykernel`'

const PROBE_SCRIPT = [
  'import json, sys',
  'info = {"ok": False, "executable": sys.executable, "version": sys.version.split()[0]}',
  'try:',
  '    import jupyter_client, ipykernel',
  '    info.update({"ok": True,',
  '        "jupyter_client": getattr(jupyter_client, "__version__", None),',
  '        "ipykernel": getattr(ipykernel, "__version__", None)})',
  'except Exception as error:',
  '    info["error"] = "%s: %s" % (type(error).__name__, error)',
  'print(json.dumps(info))',
].join('\n')

const execFileAsync = promisify(execFile)

let cache = null
let cacheAt = 0
let inflight = null

export function interpreterHint() {
  return HINT
}

export function resetInterpreterCache() {
  cache = null
  cacheAt = 0
}

async function existsExecutable(file) {
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile()) return false
    await fsp.access(file, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function findOnPath(names) {
  const found = []
  const dirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name)
      if (await existsExecutable(candidate)) found.push(candidate)
    }
  }
  return found
}

async function condaEnvironments() {
  const file = path.join(os.homedir(), '.conda', 'environments.txt')
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch {
    return []
  }
  const envs = []
  for (const line of text.split(/\r?\n/)) {
    const env = line.trim()
    if (!env || env.startsWith('#')) continue
    for (const name of ['python3', 'python']) {
      const candidate = path.join(env, 'bin', name)
      if (await existsExecutable(candidate)) {
        envs.push({ path: candidate, source: 'conda', label: `conda: ${path.basename(env) || env}` })
        break
      }
    }
  }
  return envs
}

async function collectCandidates() {
  const candidates = []
  const add = (file, source, label) => {
    if (typeof file === 'string' && file.trim() !== '') {
      candidates.push({ path: file, source, label: label || source })
    }
  }

  if (process.env.DSH_IPYNB_PYTHON) {
    add(process.env.DSH_IPYNB_PYTHON, 'DSH_IPYNB_PYTHON', 'custom: DSH_IPYNB_PYTHON')
  }
  for (const env of await condaEnvironments()) {
    add(env.path, env.source, env.label)
  }
  for (const file of await findOnPath(['python3', 'python'])) {
    add(file, 'PATH', `PATH: ${path.basename(path.dirname(path.dirname(file)))}`)
  }
  const bundled = [
    process.env.DSH_PRIMARY_RUNTIME
      ? path.join(process.env.DSH_PRIMARY_RUNTIME, 'dependencies', 'python', 'bin', 'python3')
      : null,
    process.env.DSH_HOME
      ? path.join(
          process.env.DSH_HOME,
          'dsh-runtimes',
          'dsh-primary-runtime',
          'dependencies',
          'python',
          'bin',
          'python3',
        )
      : null,
  ]
  for (const file of bundled) {
    add(file, 'bundled', 'DSH bundled Python')
  }
  return candidates
}

function lastMeaningfulLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length > 0 ? lines[lines.length - 1] : ''
}

async function probePython(python) {
  let stdout = ''
  let stderr = ''
  let failure = ''
  try {
    const result = await execFileAsync(python, ['-c', PROBE_SCRIPT], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    stdout = String(result.stdout || '')
    stderr = String(result.stderr || '')
  } catch (error) {
    stdout = String((error && error.stdout) || '')
    stderr = String((error && error.stderr) || '')
    failure = (error && error.message) || 'Python probe failed'
  }
  if (!stdout.trim()) {
    return { ok: false, detail: lastMeaningfulLine(stderr) || failure, version: null }
  }
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.trim().startsWith('{'))
  if (!line) {
    return {
      ok: false,
      detail: lastMeaningfulLine(stderr) || failure || 'Python probe produced no output',
      version: null,
    }
  }
  try {
    const data = JSON.parse(line)
    return {
      ok: Boolean(data.ok),
      executable: data.executable || python,
      version: data.version || null,
      jupyterClient: data.jupyter_client || null,
      ipykernel: data.ipykernel || null,
      detail: data.ok
        ? `jupyter_client ${data.jupyter_client || '?'} · ipykernel ${data.ipykernel || '?'}`
        : data.error || HINT,
    }
  } catch (error) {
    return { ok: false, detail: `Unreadable Python probe output: ${error.message}`, version: null }
  }
}

async function discoverUncached() {
  const seen = new Set()
  const unique = []
  for (const candidate of await collectCandidates()) {
    let real
    try {
      real = await fsp.realpath(candidate.path)
    } catch {
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    unique.push({ ...candidate, path: real })
  }
  const interpreters = new Array(unique.length)
  let index = 0
  // Probe a few interpreters at a time instead of blocking the host thread.
  const workers = Array.from({ length: Math.min(4, unique.length) }, async () => {
    for (;;) {
      const position = index
      if (position >= unique.length) return
      index += 1
      const candidate = unique[position]
      const probe = await probePython(candidate.path)
      const versionLabel = probe.version ? `Python ${probe.version}` : 'Python'
      interpreters[position] = {
        path: candidate.path,
        label: `${versionLabel} · ${candidate.label}`,
        source: candidate.source,
        ok: probe.ok,
        detail: probe.detail,
        version: probe.version || null,
        jupyterClient: probe.jupyterClient || null,
        ipykernel: probe.ipykernel || null,
      }
    }
  })
  await Promise.all(workers)
  const usable = interpreters.find((entry) => entry.ok)
  cache = {
    interpreters,
    default: usable ? usable.path : null,
    checkedAt: Date.now(),
  }
  cacheAt = Date.now()
  return cache
}

export async function discoverInterpreters(options = {}) {
  if (!options.fresh && cache && Date.now() - cacheAt < CACHE_TTL_MS) {
    return cache
  }
  if (inflight) return inflight
  const promise = discoverUncached()
  inflight = promise
  try {
    return await promise
  } finally {
    if (inflight === promise) inflight = null
  }
}

export async function resolveInterpreter(python) {
  const { interpreters, default: fallback } = await discoverInterpreters()
  const requested = typeof python === 'string' && python.trim() !== '' ? python : fallback
  if (!requested) {
    throw new ApiError(
      'kernel-unavailable',
      503,
      `No Python interpreter with jupyter_client and ipykernel was found. ${HINT}`,
    )
  }
  let real
  try {
    real = await fsp.realpath(requested)
  } catch {
    throw new ApiError('interpreter-unknown', 400, `Unknown Python interpreter: ${requested}`)
  }
  const entry = interpreters.find((candidate) => candidate.path === real)
  if (!entry) {
    throw new ApiError(
      'interpreter-unknown',
      400,
      'The selected interpreter is not in the discovered interpreter list',
    )
  }
  if (!entry.ok) {
    throw new ApiError('kernel-unavailable', 503, `${entry.path} cannot run kernels: ${entry.detail}. ${HINT}`)
  }
  return entry
}
