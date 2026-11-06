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

// Resolve a control path (status/interrupt/restart/shutdown) without requiring
// the notebook file itself to still exist: its kernel survives delete/rename,
// and the control calls must keep reaching it. Walk components so a dangling
// symlink still yields its original target, rather than becoming a different
// kernel key. Expand link contents before processing `..`; normalizing the
// whole link first could hide a workspace escape through another symlink.
async function resolveMissingTarget(candidate) {
  let target = path.parse(candidate).root
  const pending = candidate.slice(target.length).split(path.sep)
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
        target = next
        continue
      }
      if (stat.isSymbolicLink()) {
        if (++links > 40) throw new Error('Too many symbolic links')
        const link = await fsp.readlink(next)
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
  return { target, stat }
}

export async function resolveControlTarget(ctx, sessionId, requestedPath) {
  const cwd = await resolveWorkspace(ctx, sessionId)
  let resolved
  try {
    resolved = await resolveTarget(cwd, requestedPath)
  } catch (error) {
    // Only a genuinely missing path gets this fallback; permission
    // errors (which carry details) and containment failures are re-thrown.
    if (!(error instanceof ApiError) || error.code !== 'not-found' || error.details !== undefined) {
      throw error
    }
    resolved = await resolveMissingTarget(requestedCandidate(cwd, requestedPath))
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
  return target
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
