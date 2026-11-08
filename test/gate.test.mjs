import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { canCreateSymlinks, tempDir } from './python-helper.mjs'
import {
  assertNotebookPath,
  isInside,
  KernelPaths,
  resolveControlTarget,
  resolveExistingFile,
  resolveTarget,
  resolveWorkspace,
} from '../lib/gate.js'

// Windows without Developer Mode/elevation cannot create symlinks. Keep the
// lexical path cases running and skip only the ones that need a real symlink.
const symlinkSkip = (await canCreateSymlinks())
  ? false
  : 'requires symlink privileges (on Windows: enable Developer Mode or run as administrator)'
const symlinkTest = (name, fn) => nodeTest(name, { skip: symlinkSkip }, fn)
const test = nodeTest

async function workspace(t) {
  const root = await tempDir(t, 'dsh-bsb-ipynb-gate-')
  const dir = path.join(root, 'project')
  await mkdir(dir)
  await writeFile(path.join(dir, 'a.ipynb'), '{}')
  return { root, dir }
}

function ctxFor(cwd) {
  return {
    sessions: {
      get(id) {
        if (id === 's1') return { header: { cwd } }
        return undefined
      },
    },
  }
}

test('isInside accepts the root and descendants only', () => {
  assert.equal(isInside('/tmp/a', '/tmp/a'), true)
  assert.equal(isInside('/tmp/a', '/tmp/a/b'), true)
  assert.equal(isInside('/tmp/a', '/tmp/ab'), false)
  assert.equal(isInside('/tmp/a', '/tmp'), false)
})

test('resolveWorkspace resolves the session cwd', async (t) => {
  const { dir } = await workspace(t)
  assert.equal(await resolveWorkspace(ctxFor(dir), 's1'), await realpath(dir))
})

test('resolveWorkspace follows the effective working directory', async (t) => {
  const { root, dir } = await workspace(t)
  const other = path.join(root, 'other')
  await mkdir(other)
  const ctx = ctxFor(dir)
  ctx.get = (name) => (name === 'workingDirectory' ? { get: () => other } : undefined)
  assert.equal(await resolveWorkspace(ctx, 's1'), await realpath(other))
})

test('resolveWorkspace falls back to header.cwd when the optional service fails', async (t) => {
  const { dir } = await workspace(t)
  const ctx = ctxFor(dir)
  ctx.get = () => {
    throw new Error('service unavailable')
  }
  assert.equal(await resolveWorkspace(ctx, 's1'), await realpath(dir))
})

test('resolveWorkspace rejects missing sessions and cwd', async () => {
  assert.rejects(resolveWorkspace(ctxFor('/tmp'), 'missing'), (error) => error.code === 'workspace-unknown')
  assert.rejects(resolveWorkspace(ctxFor(''), 's1'), (error) => error.code === 'workspace-unknown')
})

test('resolveTarget accepts relative and absolute workspace paths', async (t) => {
  const { dir } = await workspace(t)
  const cwd = await resolveWorkspace(ctxFor(dir), 's1')
  const rel = await resolveTarget(cwd, 'a.ipynb')
  assert.equal(rel.target, path.join(cwd, 'a.ipynb'))
  const abs = await resolveTarget(cwd, path.join(cwd, 'a.ipynb'))
  assert.equal(abs.target, path.join(cwd, 'a.ipynb'))
})

test('resolveTarget rejects traversal and outside absolute paths', async (t) => {
  const { root, dir } = await workspace(t)
  await writeFile(path.join(root, 'outside.ipynb'), '{}')
  const cwd = await resolveWorkspace(ctxFor(dir), 's1')
  await assert.rejects(resolveTarget(cwd, '../outside.ipynb'), (error) => error.code === 'path-outside-root')
  await assert.rejects(resolveTarget(cwd, path.join(root, 'outside.ipynb')), (error) => error.code === 'path-outside-root')
})

symlinkTest('resolveTarget rejects symlink escapes', async (t) => {
  const { root, dir } = await workspace(t)
  await writeFile(path.join(root, 'secret.ipynb'), '{}')
  await symlink(root, path.join(dir, 'escape'))
  const cwd = await resolveWorkspace(ctxFor(dir), 's1')
  await assert.rejects(resolveTarget(cwd, 'escape/secret.ipynb'), (error) => error.code === 'path-outside-root')
})

test('resolveExistingFile requires an existing file', async (t) => {
  const { dir } = await workspace(t)
  const found = await resolveExistingFile(ctxFor(dir), 's1', 'a.ipynb')
  assert.equal(found.target, path.join(await realpath(dir), 'a.ipynb'))
  await assert.rejects(resolveExistingFile(ctxFor(dir), 's1', 'missing.ipynb'), (error) => error.code === 'not-found')
})

test('assertNotebookPath enforces the extension', async () => {
  assert.doesNotThrow(() => assertNotebookPath('/tmp/a.ipynb'))
  assert.throws(() => assertNotebookPath('/tmp/a.txt'), (error) => error.code === 'not-notebook')
})

symlinkTest('resolveControlTarget accepts a deleted notebook inside the workspace', async (t) => {
  const { root, dir } = await workspace(t)
  const cwd = await resolveWorkspace(ctxFor(dir), 's1')
  assert.equal(await resolveControlTarget(ctxFor(dir), 's1', 'a.ipynb'), path.join(cwd, 'a.ipynb'))
  await rm(path.join(dir, 'a.ipynb'))
  assert.equal(await resolveControlTarget(ctxFor(dir), 's1', 'a.ipynb'), path.join(cwd, 'a.ipynb'))
  // Missing directories under the workspace resolve lexically.
  assert.equal(
    await resolveControlTarget(ctxFor(dir), 's1', 'new/sub/notebook.ipynb'),
    path.join(cwd, 'new/sub/notebook.ipynb'),
  )
  // Escapes are still rejected for missing paths, including via symlinked dirs.
  await assert.rejects(
    resolveControlTarget(ctxFor(dir), 's1', '../outside.ipynb'),
    (error) => error.code === 'path-outside-root' && error.status === 403,
  )
  await assert.rejects(
    resolveControlTarget(ctxFor(dir), 's1', path.join(root, 'missing.ipynb')),
    (error) => error.code === 'path-outside-root' && error.status === 403,
  )
  await symlink(root, path.join(dir, 'escape'))
  await assert.rejects(
    resolveControlTarget(ctxFor(dir), 's1', 'escape/missing.ipynb'),
    (error) => error.code === 'path-outside-root' && error.status === 403,
  )
  // Extension and input validation still apply when the file is gone.
  await assert.rejects(
    resolveControlTarget(ctxFor(dir), 's1', 'missing.txt'),
    (error) => error.code === 'not-notebook' && error.status === 400,
  )
  await assert.rejects(
    resolveControlTarget(ctxFor(dir), 's1'),
    (error) => error.code === 'bad-request' && error.status === 400,
  )
})

symlinkTest('control paths retain the canonical target of dangling file and directory symlinks', async (t) => {
  const { root, dir } = await workspace(t)
  const cwd = await realpath(dir)
  await mkdir(path.join(dir, 'notebooks'))
  const target = path.join(cwd, 'notebooks', 'real.ipynb')
  await writeFile(target, '{}')
  await symlink('notebooks/real.ipynb', path.join(dir, 'relative.ipynb'))
  await symlink(target, path.join(dir, 'absolute.ipynb'))
  await symlink('relative.ipynb', path.join(dir, 'chain.ipynb'))
  await symlink('notebooks', path.join(dir, 'directory'))
  const aliases = ['relative.ipynb', 'absolute.ipynb', 'chain.ipynb', 'directory/real.ipynb']
  for (const alias of aliases) {
    assert.equal(await resolveControlTarget(ctxFor(dir), 's1', alias), target)
  }
  await rm(target)
  for (const alias of aliases) {
    assert.equal(await resolveControlTarget(ctxFor(dir), 's1', alias), target, alias)
  }
  await rm(path.join(dir, 'notebooks'), { recursive: true })
  for (const alias of aliases) {
    assert.equal(await resolveControlTarget(ctxFor(dir), 's1', alias), target, alias)
  }
})

symlinkTest('dangling symlink targets are still checked against the workspace and notebook extension', async (t) => {
  const { root, dir } = await workspace(t)
  await symlink('../missing.ipynb', path.join(dir, 'escape.ipynb'))
  await symlink(path.join(root, 'missing-directory'), path.join(dir, 'escape-directory'))
  for (const alias of ['escape.ipynb', 'escape-directory/nb.ipynb']) {
    await assert.rejects(resolveControlTarget(ctxFor(dir), 's1', alias),
      (error) => error.code === 'path-outside-root' && error.status === 403, alias)
  }
  await symlink('missing.txt', path.join(dir, 'wrong-extension.ipynb'))
  await assert.rejects(resolveControlTarget(ctxFor(dir), 's1', 'wrong-extension.ipynb'),
    (error) => error.code === 'not-notebook' && error.status === 400)
})

symlinkTest('missing-target resolution expands symlinks before parent components', async (t) => {
  const { root, dir } = await workspace(t)
  const outside = path.join(root, 'outside', 'nested')
  await mkdir(outside, { recursive: true })
  await symlink(outside, path.join(dir, 'jump'))
  await symlink('jump/../missing.ipynb', path.join(dir, 'escape.ipynb'))
  await assert.rejects(resolveControlTarget(ctxFor(dir), 's1', 'escape.ipynb'),
    (error) => error.code === 'path-outside-root' && error.status === 403)

  await mkdir(path.join(dir, 'inside', 'nested'), { recursive: true })
  await symlink('inside/nested', path.join(dir, 'local-jump'))
  await symlink('local-jump/../missing.ipynb', path.join(dir, 'local.ipynb'))
  assert.equal(await resolveControlTarget(ctxFor(dir), 's1', 'local.ipynb'),
    path.join(await realpath(dir), 'inside', 'missing.ipynb'))
})

symlinkTest('control paths reject symlink cycles and non-directory ancestors', async (t) => {
  const { root, dir } = await workspace(t)
  await symlink('two.ipynb', path.join(dir, 'one.ipynb'))
  await symlink('one.ipynb', path.join(dir, 'two.ipynb'))
  await symlink('a.ipynb/child.ipynb', path.join(dir, 'invalid.ipynb'))
  // realpath stops at the missing component, so these exercise the fallback's
  // own loop limit and non-directory check rather than realpath's errors.
  await symlink('missing/../loop.ipynb', path.join(dir, 'loop.ipynb'))
  await symlink('missing/../a.ipynb/../other.ipynb', path.join(dir, 'file-parent.ipynb'))
  for (const alias of ['one.ipynb', 'invalid.ipynb', 'loop.ipynb', 'file-parent.ipynb']) {
    await assert.rejects(resolveControlTarget(ctxFor(dir), 's1', alias),
      (error) => error.code === 'not-found' && error.details !== undefined, alias)
  }
})

symlinkTest('missing-target resolution still rejects an existing directory named as a notebook', async (t) => {
  const { root, dir } = await workspace(t)
  await mkdir(path.join(dir, 'folder.ipynb'))
  await symlink('missing/../folder.ipynb', path.join(dir, 'alias.ipynb'))
  await assert.rejects(resolveControlTarget(ctxFor(dir), 's1', 'alias.ipynb'),
    (error) => error.code === 'not-notebook' && error.status === 400)
})

test('resolveWorkspace rejects a relative session cwd', async () => {
  await assert.rejects(resolveWorkspace(ctxFor('relative/project'), 's1'), (error) => (
    error.code === 'workspace-unknown' && error.status === 400
  ))
})

test('control resolution retries a transient file change instead of failing', async (t) => {
  const { dir } = await workspace(t)
  const realLstat = fsp.lstat
  const realReadlink = fsp.readlink
  let linkServed = false
  t.mock.method(fsp, 'lstat', async (file) => {
    // Match on the basename: the tmpdir path may be an alias (/var vs
    // /private/var on macOS, short names on some Windows runners).
    if (!linkServed && path.basename(String(file)) === 'a.ipynb') {
      linkServed = true
      return { isSymbolicLink: () => true, dev: 1, ino: 2, birthtimeMs: 3 }
    }
    return realLstat.call(fsp, file)
  })
  t.mock.method(fsp, 'readlink', async (file) => {
    if (path.basename(String(file)) === 'a.ipynb') return 'elsewhere.ipynb'
    return realReadlink.call(fsp, file)
  })
  const kernelPaths = new KernelPaths(ctxFor(dir), { peek: () => null })
  const resolved = await kernelPaths.resolve('s1', 'a.ipynb', true)
  assert.equal(resolved.target, path.join(await realpath(dir), 'a.ipynb'))
  assert.equal(linkServed, true, 'the first attempt observed the transient change')
})

test('a Windows control path with an unobserved case spelling still reaches its live kernel', {
  skip: process.platform !== 'win32' && 'the case-insensitive alias fallback is Windows-only',
}, async (t) => {
  const { dir } = await workspace(t)
  const file = path.join(dir, 'Actual.ipynb')
  await writeFile(file, '{}')
  const cwd = await realpath(dir)
  const canonical = await realpath(file)
  const entry = {}
  const kernels = { peek: (target) => (target === canonical ? entry : null) }
  const paths = new KernelPaths(ctxFor(dir), kernels)
  // Only the canonical spelling is observed while the file exists.
  assert.equal((await paths.resolve('s1', 'Actual.ipynb', true)).target, canonical)
  // Alias history stays scoped to the session that observed it.
  const sessions = new Map([
    ['s1', { header: { cwd: dir } }],
    ['s2', { header: { cwd: dir } }],
  ])
  const otherPaths = new KernelPaths({ sessions: { get: (id) => sessions.get(id) } }, kernels)
  assert.equal((await otherPaths.resolve('s1', 'Actual.ipynb', true)).target, canonical)
  await rm(file)
  const otherSession = await otherPaths.resolve('s2', 'actual.ipynb', true)
  assert.equal(otherSession.target, path.join(cwd, 'actual.ipynb'), 'another session cannot borrow the spelling history')
  assert.equal(otherSession.known, false)
  const recovered = await paths.resolve('s1', 'actual.ipynb', true)
  assert.equal(recovered.target, canonical, 'an unobserved case spelling recovers the canonical kernel key')
  assert.equal(recovered.known, true)
})

test('an observed spelling recovers the canonical kernel key after deletion', async (t) => {
  const { dir } = await workspace(t)
  const file = path.join(dir, 'a.ipynb')
  const cwd = await realpath(dir)
  const canonical = await realpath(file)
  const entry = {}
  const kernels = { peek: (target) => (target === canonical ? entry : null) }
  const paths = new KernelPaths(ctxFor(dir), kernels)
  assert.equal((await paths.resolve('s1', 'a.ipynb', true)).target, canonical)
  await rm(file)
  const recovered = await paths.resolve('s1', 'a.ipynb', true)
  assert.equal(recovered.target, canonical)
  assert.equal(recovered.known, true)
})

test('ambiguous case-variant aliases fail closed instead of selecting a kernel', {
  skip: process.platform !== 'win32' && 'the case-insensitive alias fallback is Windows-only',
}, async (t) => {
  const { dir } = await workspace(t)
  const cwd = await realpath(dir)
  const observedFile = path.join(dir, 'alpha.ipynb')
  await writeFile(observedFile, '{}')
  const canonical = await realpath(observedFile)
  const entry = {}
  const otherEntry = {}
  const otherTarget = path.join(cwd, 'other.ipynb')
  const entries = new Map([[canonical, entry], [otherTarget, otherEntry]])
  const kernels = { peek: (target) => entries.get(target) || null }
  const paths = new KernelPaths(ctxFor(dir), kernels)
  const observed = await paths.resolve('s1', 'alpha.ipynb', true)
  assert.equal(observed.target, canonical)
  const saved = paths.aliases.get(observed.key)
  assert.ok(saved, 'the observed spelling registered an alias')
  // A second case-variant alias that points at a different live kernel target.
  paths.aliases.set(JSON.stringify(['s1', cwd, path.join(cwd, 'ALPHA.ipynb')]), {
    target: otherTarget,
    nodes: saved.nodes,
    entry: new WeakRef(otherEntry),
  })
  await rm(observedFile)
  const ambiguous = await paths.resolve('s1', 'Alpha.ipynb', true)
  assert.equal(ambiguous.known, false, 'an ambiguous case match must not guess a kernel')
  assert.equal(ambiguous.target, path.join(cwd, 'Alpha.ipynb'))
})

test('a dead kernel entry is never revived by the case-insensitive fallback', {
  skip: process.platform !== 'win32' && 'the case-insensitive alias fallback is Windows-only',
}, async (t) => {
  const { dir } = await workspace(t)
  const cwd = await realpath(dir)
  const file = path.join(dir, 'Actual.ipynb')
  await writeFile(file, '{}')
  const canonical = await realpath(file)
  const entry = {}
  const entries = new Map([[canonical, entry]])
  const kernels = { peek: (target) => entries.get(target) || null }
  const paths = new KernelPaths(ctxFor(dir), kernels)
  assert.equal((await paths.resolve('s1', 'Actual.ipynb', true)).target, canonical)
  await rm(file)
  entries.delete(canonical)
  const recovered = await paths.resolve('s1', 'actual.ipynb', true)
  assert.equal(recovered.known, false)
  assert.equal(recovered.target, path.join(cwd, 'actual.ipynb'))
})
