// Follow the linked worktree evidenced by a session's own tool calls.
// Compatible with dsh-better-sidebar 0.32.x, but deliberately independent of
// its TypeScript sources: Node cannot type-strip modules inside node_modules.

import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execGit = promisify(execFile)
const OVERRIDE_ENV = 'DSH_SIDEBAR_WORKTREE_ROOT'
const CACHE_TTL_MS = 15_000
const MAX_EVENTS = 4_000
const MAX_PROBES = 24
const STRUCTURED_FIELD = /^(cwd|workdir|work_dir|workingdirectory|path|file_path|filepath|target|root)$/i
const WINDOWS_PATH = /[A-Za-z]:(?:\\|\/)[^\\/\s"'\x60,;|)<>*?]+(?:[\\/][^\\/\s"'\x60,;|)<>*?]+)*/g
const cache = new Map()
const inflight = new Map()

function pathKey(value) {
  const normalized = path.normalize(value).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function inside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function canonical(value) {
  try {
    return await fsp.realpath(value)
  } catch {
    return value
  }
}

async function runGit(cwd, args) {
  const result = await execGit('git', ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  })
  return result.stdout.trim()
}

async function topLevelOf(candidate) {
  let directory = candidate
  try {
    if (!(await fsp.stat(candidate)).isDirectory()) directory = path.dirname(candidate)
  } catch {
    directory = path.dirname(candidate)
  }
  try {
    const top = await runGit(directory, ['rev-parse', '--show-toplevel'])
    return top && path.isAbsolute(top) ? canonical(top) : null
  } catch {
    return null
  }
}

async function gitIdentityOf(directory) {
  try {
    const lines = (await runGit(directory, ['rev-parse', '--absolute-git-dir', '--git-common-dir'])).split(/\r?\n/)
    if (!lines[0] || !lines[1]) return null
    return {
      gitDir: await canonical(lines[0]),
      commonDir: await canonical(path.isAbsolute(lines[1]) ? lines[1] : path.join(directory, lines[1])),
    }
  } catch {
    return null
  }
}

function addPath(weights, value, weight) {
  if (typeof value !== 'string') return
  const normalized = value.replace(/[\\/]+$/, '')
  if (!normalized || !path.isAbsolute(normalized)) return
  const key = pathKey(normalized)
  const current = weights.get(key)
  if (current) current.score += weight
  else weights.set(key, { path: normalized, score: weight })
}

function collectPaths(value, weights, structured = false) {
  if (typeof value === 'string') {
    if (path.isAbsolute(value)) {
      addPath(weights, value, structured ? 8 : 1)
      return
    }
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        collectPaths(JSON.parse(value), weights, structured)
      } catch {
        // Not JSON: continue with embedded Windows paths.
      }
    }
    for (const match of value.match(WINDOWS_PATH) || []) addPath(weights, match, 1)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, weights, structured)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectPaths(item, weights, structured || STRUCTURED_FIELD.test(key))
    }
  }
}

function sessionEvents(session) {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents() || []
  if (!Number.isInteger(session.seq) || typeof session.eventAt !== 'function') return []
  const start = Math.max(0, session.seq - MAX_EVENTS)
  const events = []
  for (let index = start; index < session.seq; index += 1) events.push(session.eventAt(index))
  return events
}

async function computeRoot(ctx, sessionId, base) {
  const session = ctx.sessions.get(sessionId)
  const canonicalBase = await canonical(base)
  if (!session) return canonicalBase
  const events = sessionEvents(session)
  if (events.length === 0) return canonicalBase
  if (!(await topLevelOf(canonicalBase))) return canonicalBase

  const identities = new Map()
  const identityOf = async (directory) => {
    const key = pathKey(directory)
    if (!identities.has(key)) identities.set(key, await gitIdentityOf(directory))
    return identities.get(key)
  }
  const adoptable = async (top) => {
    const candidate = await identityOf(top)
    if (!candidate || pathKey(candidate.gitDir) === pathKey(candidate.commonDir)) return false
    if (!inside(canonicalBase, top)) return true
    if (path.parse(canonicalBase).root === canonicalBase) return true
    const workspace = await identityOf(canonicalBase)
    return workspace && pathKey(candidate.commonDir) === pathKey(workspace.commonDir)
  }

  let probes = 0
  const start = Math.max(0, events.length - MAX_EVENTS)
  for (let index = events.length - 1; index >= start; index -= 1) {
    const event = events[index]
    if (event?.type === 'working-directory/change') break
    if (event?.type !== 'tool/call') continue
    const weights = new Map()
    collectPaths(event.data, weights)
    const ordered = [...weights.values()].sort((left, right) => right.score - left.score)
    const scores = new Map()
    for (const candidate of ordered) {
      if (probes >= MAX_PROBES) break
      probes += 1
      const top = await topLevelOf(candidate.path)
      if (!top || pathKey(top) === pathKey(canonicalBase) || !(await adoptable(top))) continue
      const key = pathKey(top)
      const current = scores.get(key)
      if (current) current.score += candidate.score
      else scores.set(key, { top, score: candidate.score })
    }
    if (scores.size) {
      return [...scores.values()].sort((left, right) => right.score - left.score)[0].top
    }
    if (probes >= MAX_PROBES) break
  }
  return canonicalBase
}

export async function activeWorktreeRootOf(ctx, sessionId, base) {
  const override = String(process.env[OVERRIDE_ENV] || '').trim()
  if (override && path.isAbsolute(override)) return override
  const session = ctx.sessions.get(sessionId)
  const sequence = Number.isInteger(session?.seq) ? session.seq : null
  const key = `${sessionId}\0${base}`
  const cached = cache.get(key)
  if (cached && cached.sequence === sequence && cached.expires > Date.now()) {
    try {
      if ((await fsp.stat(cached.root)).isDirectory()) return cached.root
    } catch {
      // A missing linked root is recomputed below.
    }
    cache.delete(key)
  }
  const flightKey = `${key}\0${sequence ?? ''}`
  if (inflight.has(flightKey)) return inflight.get(flightKey)
  const pending = computeRoot(ctx, sessionId, base).catch(() => canonical(base))
  inflight.set(flightKey, pending)
  try {
    const root = await pending
    cache.set(key, { root, sequence, expires: Date.now() + CACHE_TTL_MS })
    while (cache.size > 256) cache.delete(cache.keys().next().value)
    return root
  } finally {
    if (inflight.get(flightKey) === pending) inflight.delete(flightKey)
  }
}
