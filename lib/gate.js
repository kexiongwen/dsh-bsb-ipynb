// Session workspace + path containment for dsh-bsb-ipynb.
//
// Notebook paths come from the sidebar file tree, so they may be absolute or
// relative to the conversation workspace. The workspace itself is always the
// session's own cwd; client-supplied cwd fallbacks are deliberately ignored.

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { ApiError } from './json.js'

export function isInside(root, target) {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

export async function resolveWorkspace(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new ApiError('bad-request', 400, 'sessionId is required')
  }
  const session = ctx.sessions.get(sessionId)
  let cwd = session && session.header ? session.header.cwd : undefined
  // Follow a session whose working directory changed after it was created
  // (better-sidebar's own file tree uses the effective directory too). Older
  // hosts without the optional workingDirectory service keep header.cwd.
  try {
    const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (session && workingDirectory && typeof workingDirectory.get === 'function') {
      const current = workingDirectory.get(session)
      if (typeof current === 'string' && current.trim() !== '') cwd = current
    }
  } catch {
    // Fall back to the session header directory.
  }
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new ApiError('workspace-unknown', 400, `No workspace is known for session ${sessionId}`)
  }
  let real
  try {
    real = await fsp.realpath(cwd)
    const stat = await fsp.stat(real)
    if (!stat.isDirectory()) throw new Error('not a directory')
  } catch (error) {
    throw new ApiError('workspace-unknown', 400, `Session workspace is not accessible: ${cwd}`, {
      reason: error.message,
    })
  }
  return real
}

function requestedCandidate(cwdReal, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
    throw new ApiError('bad-request', 400, 'path is required')
  }
  return path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(cwdReal, requestedPath)
}

export async function resolveTarget(cwdReal, requestedPath) {
  const candidate = requestedCandidate(cwdReal, requestedPath)
  let real
  let stat
  try {
    real = await fsp.realpath(candidate)
    stat = await fsp.stat(real)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new ApiError('not-found', 404, `File not found: ${requestedPath}`)
    }
    throw new ApiError('not-found', 404, `File is not accessible: ${requestedPath}`, {
      reason: error.message,
    })
  }
  if (!isInside(cwdReal, real)) {
    throw new ApiError('path-outside-root', 403, 'Path is outside the session workspace', {
      path: requestedPath,
    })
  }
  return { target: real, stat }
}

// Walk existing or deleted control paths, retaining component identities when
// available. A kernel survives delete/rename, so a dangling link must still
// resolve to its target. Expand link contents before processing `..`;
// normalizing the whole link first could hide a workspace escape.
async function walkTarget(candidate) {
  let target = path.parse(candidate).root
  const pending = candidate.slice(target.length).split(path.sep)
  const nodes = []
  let links = 0
  let stat
  try {
    while (pending.length) {
      const part = pending.shift()
      if (!part || part === '.') continue
      if (part === '..') {
        target = path.dirname(target)
        continue
      }
      const next = path.join(target, part)
      let stat
      try {
        stat = await fsp.lstat(next)
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error
        nodes.push({ part, kind: 'missing' })
        target = next
        continue
      }
      const node = {
        part,
        kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file',
        dev: stat.dev,
        ino: stat.ino,
        birthtimeMs: stat.birthtimeMs,
      }
      nodes.push(node)
      if (stat.isSymbolicLink()) {
        if (++links > 40) throw new Error('Too many symbolic links')
        const link = await fsp.readlink(next)
        node.link = link
        if (path.isAbsolute(link)) {
          target = path.parse(link).root
          pending.unshift(...link.slice(target.length).split(path.sep))
        } else {
          pending.unshift(...link.split(path.sep))
        }
        continue
      }
      if (pending.length && !stat.isDirectory()) throw new Error('Not a directory')
      // Preserve the filesystem's canonical spelling for existing components.
      target = await fsp.realpath(next)
    }
    try {
      stat = await fsp.stat(target)
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
  } catch (error) {
    throw new ApiError('not-found', 404, `File is not accessible: ${candidate}`, {
      reason: error.message,
    })
  }
  return { target, stat, nodes }
}

async function resolveNotebookTarget(ctx, sessionId, requestedPath, allowMissing, trace = false) {
  const cwd = await resolveWorkspace(ctx, sessionId)
  const candidate = requestedCandidate(cwd, requestedPath)
  let resolved
  try {
    resolved = await resolveTarget(cwd, requestedPath)
  } catch (error) {
    // Only a genuinely missing path gets this fallback; permission
    // errors (which carry details) and containment failures are re-thrown.
    if (!allowMissing || !(error instanceof ApiError) || error.code !== 'not-found' || error.details !== undefined) {
      throw error
    }
  }
  if (!resolved || trace) {
    const walked = await walkTarget(candidate)
    // Never associate a target resolved before a filesystem change with the
    // path-component identities observed after that change.
    if (resolved && (!walked.stat || walked.target !== resolved.target)) {
      throw new ApiError('not-found', 404, `File changed while resolving: ${requestedPath}`)
    }
    resolved = walked
  }
  const { target, stat } = resolved
  if (stat && !stat.isFile()) {
    throw new ApiError('not-notebook', 400, `Not a file: ${requestedPath}`)
  }
  if (!isInside(cwd, target)) {
    throw new ApiError('path-outside-root', 403, 'Path is outside the session workspace', {
      path: requestedPath,
    })
  }
  assertNotebookPath(target)
  return { cwd, candidate, ...resolved }
}

export async function resolveControlTarget(ctx, sessionId, requestedPath) {
  return (await resolveNotebookTarget(ctx, sessionId, requestedPath, true)).target
}

function samePathIdentity(before, after) {
  return before.length === after.length && before.every((node, index) => {
    const current = after[index]
    if (node.part !== current.part) return false
    // Ordinary files/directories may have been deleted. A missing or replaced
    // symlink must never inherit the target of an earlier link at that name.
    if (current.kind === 'missing') return node.kind === 'file' || node.kind === 'directory'
    return node.kind === current.kind && node.dev === current.dev && node.ino === current.ino &&
      node.birthtimeMs === current.birthtimeMs && node.link === current.link
  })
}

// The filesystem cannot recover canonical spelling once a component is gone
// (e.g. Actual.ipynb reached through a link containing actual.ipynb on macOS).
// Keep the evidence obtained while that path existed, scoped to its session,
// real workspace and live kernel entry. Never infer identity by lowercasing.
export class KernelPaths {
  constructor(ctx, kernels) {
    this.ctx = ctx
    this.kernels = kernels
    this.aliases = new Map()
  }

  async resolve(sessionId, requestedPath, allowMissing = false) {
    const resolved = await resolveNotebookTarget(this.ctx, sessionId, requestedPath, allowMissing, true)
    const key = JSON.stringify([sessionId, resolved.cwd, resolved.candidate])
    // Authorization above always runs first, even for a remembered alias.
    for (const [alias, saved] of this.aliases) {
      const entry = saved.entry.deref()
      if (!entry || this.kernels.peek(saved.target) !== entry) this.aliases.delete(alias)
    }
    const saved = this.aliases.get(key)
    this.aliases.delete(key)
    if (!resolved.stat && saved && isInside(resolved.cwd, saved.target) &&
        samePathIdentity(saved.nodes, resolved.nodes)) {
      const recovered = { ...resolved, key, target: saved.target, nodes: saved.nodes, known: true }
      this.remember(recovered, saved.entry.deref())
      return recovered
    }
    const result = { ...resolved, key, known: Boolean(resolved.stat) }
    this.remember(result, this.kernels.peek(result.target))
    return result
  }

  prepareReplacement(resolved) {
    const { target, key } = resolved
    const previous = this.kernels.peek(target)
    const requestedAlias = this.aliases.get(key)
    const savedAliases = [...this.aliases].filter(([, saved]) =>
      previous && saved.target === target && saved.entry.deref() === previous)
    // Capture before awaiting an authorized interpreter switch: other control
    // requests may prune aliases while the old entry is being shut down.
    return (entry) => {
      if (!entry || this.kernels.peek(target) !== entry) return
      // The requesting path can also change while startup is pending. Keep a
      // newer observation instead of overwriting it with our earlier trace.
      const currentRequest = this.aliases.get(key)
      if (!currentRequest || currentRequest === requestedAlias) this.remember(resolved, entry)
      if (entry === previous) return
      for (const [key, saved] of savedAliases) {
        const current = this.aliases.get(key)
        // Do not overwrite an alias that another request has since reassigned.
        if (current && (current.target !== target || current.entry.deref() !== previous)) continue
        this.remember({ key, target, nodes: (current || saved).nodes, known: true }, entry)
      }
    }
  }

  remember(resolved, entry) {
    if (!resolved.known || !entry || this.kernels.peek(resolved.target) !== entry) return
    this.aliases.delete(resolved.key)
    this.aliases.set(resolved.key, {
      target: resolved.target,
      nodes: resolved.nodes,
      entry: new WeakRef(entry),
    })
    // Requests may use arbitrarily many aliases for one live notebook. Bound
    // retained metadata without retaining dead KernelEntry objects themselves.
    while (this.aliases.size > 1024) this.aliases.delete(this.aliases.keys().next().value)
  }
}

export async function resolveExistingFile(ctx, sessionId, requestedPath) {
  const cwd = await resolveWorkspace(ctx, sessionId)
  const { target, stat } = await resolveTarget(cwd, requestedPath)
  if (!stat.isFile()) {
    throw new ApiError('not-notebook', 400, `Not a file: ${requestedPath}`)
  }
  return { cwd, target, stat }
}

export function assertNotebookPath(target) {
  if (path.extname(target).toLowerCase() !== '.ipynb') {
    throw new ApiError('not-notebook', 400, 'Only .ipynb notebooks are supported')
  }
}
