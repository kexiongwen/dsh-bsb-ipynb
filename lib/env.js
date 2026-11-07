// Python interpreter discovery for dsh-bsb-ipynb.
//
// Candidates are laid out per platform: POSIX environments keep python3/python
// under bin/, while Windows environments use python.exe at the environment root
// (conda) or under Scripts/ (venvs). A candidate is only usable when it can
// import both jupyter_client and ipykernel. The DSH-bundled Python is
// intentionally probed too, but it is usually reported as unusable because it
// ships without those packages.

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

const IS_WINDOWS = process.platform === 'win32'
// Application execution aliases under WindowsApps are reparse points that open
// the Store; they are not Python interpreters and their realpath fails.
const WINDOWS_STORE_ALIAS = /[\\/]Microsoft[\\/]WindowsApps[\\/]/i

// Map a bare command name onto the files Windows can actually execute. Node's
// spawn resolves a bare name through PATH/PATHEXT, but fs.stat does not, so
// discovery has to try the concrete file names itself.
function executableFileNames(name) {
  if (!IS_WINDOWS) return [name]
  const names = [`${name}.exe`]
  // PATHEXT is the authoritative extension list; only native executable
  // entries can launch a kernel, so shell wrappers (.cmd/.bat) are skipped.
  const extensions = String(process.env.PATHEXT || '')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension === '.exe' || extension === '.com')
  for (const extension of extensions) {
    const candidate = name + extension
    if (!names.includes(candidate)) names.push(candidate)
  }
  if (!names.includes(name)) names.push(name)
  return names
}

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

// Read the current discovery result without triggering a probe (used by the
// cheap /health route; the full list comes from discoverInterpreters()).
export function cachedInterpreters() {
  return cache
}

async function existsExecutable(file) {
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile()) return false
    // fs.access(X_OK) is a no-op on Windows (there is no POSIX execute bit), so
    // there this only proves "exists and is a file"; the probe is what actually
    // confirms the candidate can run a kernel.
    await fsp.access(file, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function findOnPath(names) {
  const found = []
  const seen = new Set()
  const dirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
  for (const name of names) {
    for (const dir of dirs) {
      for (const fileName of executableFileNames(name)) {
        const candidate = path.join(dir, fileName)
        if (IS_WINDOWS && WINDOWS_STORE_ALIAS.test(candidate)) continue
        // PATH is case-insensitive on Windows: keep one entry per file.
        const key = IS_WINDOWS ? candidate.toLowerCase() : candidate
        if (seen.has(key)) continue
        if (await existsExecutable(candidate)) {
          seen.add(key)
          found.push(candidate)
        }
      }
    }
  }
  return found
}

function condaInterpreterCandidates(environment) {
  if (!IS_WINDOWS) {
    return ['python3', 'python'].map((name) => path.join(environment, 'bin', name))
  }
  // A Windows conda environment keeps its interpreter at the environment root
  // (no bin/ directory); keep the Scripts/ fallback for unusual layouts.
  return [
    path.join(environment, 'python.exe'),
    path.join(environment, 'python3.exe'),
    path.join(environment, 'Scripts', 'python.exe'),
  ]
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
    for (const candidate of condaInterpreterCandidates(env)) {
      if (await existsExecutable(candidate)) {
        envs.push({ path: candidate, source: 'conda', label: `conda: ${path.basename(env) || env}` })
        break
      }
    }
  }
  return envs
}

async function resolveInterpreterIdentity(file) {
  const candidate = path.resolve(file)
  try {
    const venvConfig = await fsp.stat(path.join(path.dirname(path.dirname(candidate)), 'pyvenv.cfg'))
    if (venvConfig.isFile()) return candidate
  } catch {
    // Not a virtual environment; retain the existing realpath de-duplication.
  }
  return fsp.realpath(candidate)
}

async function collectCandidates() {
  const candidates = []
  const add = (file, source, label) => {
    if (typeof file === 'string' && file.trim() !== '') {
      candidates.push({ path: file, source, label: label || source })
    }
  }

  if (process.env.DSH_IPYNB_PYTHON) {
    add(process.env.DSH_IPYNB_PYTHON.trim(), 'DSH_IPYNB_PYTHON', 'custom: DSH_IPYNB_PYTHON')
  }
  for (const env of await condaEnvironments()) {
    add(env.path, env.source, env.label)
  }
  for (const file of await findOnPath(['python3', 'python'])) {
    add(file, 'PATH', `PATH: ${path.basename(path.dirname(file))}`)
  }
  const runtimes = []
  if (process.env.DSH_PRIMARY_RUNTIME) runtimes.push(process.env.DSH_PRIMARY_RUNTIME)
  if (process.env.DSH_HOME) {
    runtimes.push(path.join(process.env.DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime'))
  }
  for (const runtime of runtimes) {
    add(
      IS_WINDOWS
        // The Windows runtime payload ships a portable CPython distribution
        // without bin/: the interpreter sits next to its DLLs and Lib/.
        ? path.join(runtime, 'dependencies', 'python', 'python.exe')
        : path.join(runtime, 'dependencies', 'python', 'bin', 'python3'),
      'bundled',
      'DSH bundled Python',
    )
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
      ok: !failure && Boolean(data.ok),
      executable: data.executable || python,
      version: data.version || null,
      jupyterClient: data.jupyter_client || null,
      ipykernel: data.ipykernel || null,
      detail: failure || (data.ok
        ? `jupyter_client ${data.jupyter_client || '?'} · ipykernel ${data.ipykernel || '?'}`
        : data.error || HINT),
    }
  } catch (error) {
    return { ok: false, detail: `Unreadable Python probe output: ${error.message}`, version: null }
  }
}

async function discoverUncached() {
  const seen = new Set()
  const unique = []
  const unresolved = []
  for (const candidate of await collectCandidates()) {
    if (candidate.source === 'DSH_IPYNB_PYTHON' && !path.isAbsolute(candidate.path)) {
      // A bare command (`python`) or a relative path cannot be probed reliably:
      // path.resolve would resolve it against the host process directory.
      unresolved.push({
        path: candidate.path,
        label: `Python · ${candidate.label}`,
        source: candidate.source,
        ok: false,
        detail: 'DSH_IPYNB_PYTHON must be an absolute path to a Python executable',
        version: null,
        jupyterClient: null,
        ipykernel: null,
      })
      continue
    }
    let resolved
    try {
      // Resolving a venv's bin/python symlink would discard the environment
      // identity that Python derives from its invocation path and pyvenv.cfg.
      resolved = await resolveInterpreterIdentity(candidate.path)
    } catch (error) {
      // Keep a misconfigured DSH_IPYNB_PYTHON visible in the list so the user
      // can see why it was not used instead of it silently disappearing.
      if (candidate.source === 'DSH_IPYNB_PYTHON') {
        unresolved.push({
          path: candidate.path,
          label: `Python · ${candidate.label}`,
          source: candidate.source,
          ok: false,
          detail: `Not executable: ${error.message}`,
          version: null,
          jupyterClient: null,
          ipykernel: null,
        })
      }
      continue
    }
    if (seen.has(resolved)) continue
    seen.add(resolved)
    unique.push({ ...candidate, path: resolved })
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
  interpreters.push(...unresolved)
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
  if (python !== undefined && python !== null && (typeof python !== 'string' || python.trim() === '')) {
    throw new ApiError('bad-request', 400, 'python must be a non-empty string')
  }
  if (typeof python === 'string' && python.trim() !== '' && !path.isAbsolute(python.trim())) {
    throw new ApiError('bad-request', 400, 'python must be an absolute interpreter path')
  }
  const { interpreters, default: fallback } = await discoverInterpreters()
  const requested = typeof python === 'string' ? python.trim() : fallback
  if (!requested) {
    const found = interpreters.length
    const reason = found === 0
      ? 'No Python interpreter candidates were discovered on this platform; on Windows set DSH_IPYNB_PYTHON to an absolute python.exe path'
      : `None of the ${found} discovered Python interpreter(s) can run kernels: ${
        interpreters.slice(0, 3).map((entry) => `${entry.path} (${entry.detail})`).join('; ')
      }`
    throw new ApiError('kernel-unavailable', 503, `${reason}. ${HINT}`)
  }
  let resolved
  try {
    resolved = await resolveInterpreterIdentity(requested)
  } catch {
    throw new ApiError('interpreter-unknown', 400, `Unknown Python interpreter: ${requested}`)
  }
  const entry = interpreters.find((candidate) => candidate.path === resolved)
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
