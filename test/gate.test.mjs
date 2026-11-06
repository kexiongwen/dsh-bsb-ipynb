import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  assertNotebookPath,
  isInside,
  resolveExistingFile,
  resolveTarget,
  resolveWorkspace,
} from '../lib/gate.js'

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-bsb-ipynb-gate-'))
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

test('resolveWorkspace resolves the session cwd', async () => {
  const { dir } = await workspace()
  assert.equal(await resolveWorkspace(ctxFor(dir), 's1'), await realpath(dir))
})

test('resolveWorkspace follows the effective working directory', async () => {
  const { root, dir } = await workspace()
  const other = path.join(root, 'other')
  await mkdir(other)
  const ctx = ctxFor(dir)
  ctx.get = (name) => (name === 'workingDirectory' ? { get: () => other } : undefined)
  assert.equal(await resolveWorkspace(ctx, 's1'), await realpath(other))
})

test('resolveWorkspace falls back to header.cwd when the optional service fails', async () => {
  const { dir } = await workspace()
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

test('resolveTarget accepts relative and absolute workspace paths', async () => {
  const { dir } = await workspace()
  const cwd = await resolveWorkspace(ctxFor(dir), 's1')
  const rel = await resolveTarget(cwd, 'a.ipynb')
  assert.equal(rel.target, path.join(cwd, 'a.ipynb'))
  const abs = await resolveTarget(cwd, path.join(cwd, 'a.ipynb'))
  assert.equal(abs.target, path.join(cwd, 'a.ipynb'))
})

test('resolveTarget rejects traversal and outside absolute paths', async () => {
  const { root, dir } = await workspace()
  await writeFile(path.join(root, 'outside.ipynb'), '{}')
  const cwd = await resolveWorkspace(ctxFor(dir), 's1')
  await assert.rejects(resolveTarget(cwd, '../outside.ipynb'), (error) => error.code === 'path-outside-root')
  await assert.rejects(resolveTarget(cwd, path.join(root, 'outside.ipynb')), (error) => error.code === 'path-outside-root')
})

test('resolveTarget rejects symlink escapes', async () => {
  const { root, dir } = await workspace()
  await writeFile(path.join(root, 'secret.ipynb'), '{}')
  await symlink(root, path.join(dir, 'escape'))
  const cwd = await resolveWorkspace(ctxFor(dir), 's1')
  await assert.rejects(resolveTarget(cwd, 'escape/secret.ipynb'), (error) => error.code === 'path-outside-root')
})

test('resolveExistingFile requires an existing file', async () => {
  const { dir } = await workspace()
  const found = await resolveExistingFile(ctxFor(dir), 's1', 'a.ipynb')
  assert.equal(found.target, path.join(await realpath(dir), 'a.ipynb'))
  await assert.rejects(resolveExistingFile(ctxFor(dir), 's1', 'missing.ipynb'), (error) => error.code === 'not-found')
})

test('assertNotebookPath enforces the extension', async () => {
  assert.doesNotThrow(() => assertNotebookPath('/tmp/a.ipynb'))
  assert.throws(() => assertNotebookPath('/tmp/a.txt'), (error) => error.code === 'not-notebook')
})
