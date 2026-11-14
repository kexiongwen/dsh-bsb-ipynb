import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { resolveExistingFile, resolveWorkspace } from '../lib/gate.js'
import { tempDir } from './python-helper.mjs'

const execute = promisify(execFile)
const git = async (cwd, ...args) => {
  await execute('git', ['-C', cwd, ...args], { timeout: 10_000, windowsHide: true })
}

test('a session follows its evidenced linked worktree and later directory change', async (t) => {
  const root = await tempDir(t, 'dsh-ipynb-active-worktree-')
  const main = path.join(root, 'main')
  const linked = path.join(root, 'linked')
  await mkdir(main)
  await git(main, 'init')
  await git(main, 'config', 'user.email', 'e2e@example.test')
  await git(main, 'config', 'user.name', 'E2E')
  await writeFile(path.join(main, 'demo.ipynb'), '{}')
  await git(main, 'add', 'demo.ipynb')
  await git(main, 'commit', '-m', 'initial')
  await git(main, 'worktree', 'add', '-b', 'review-worktree', linked)
  await writeFile(path.join(linked, 'demo.ipynb'), '{}')

  let events = [{ seq: 1, type: 'tool/call', data: { cwd: linked } }]
  const session = {
    header: { cwd: main },
    get seq() { return events.length },
    snapshotEvents: () => events,
  }
  const ctx = { sessions: { get: () => session } }
  assert.equal(await resolveWorkspace(ctx, 's1'), await realpath(linked))
  assert.equal(
    (await resolveExistingFile(ctx, 's1', 'demo.ipynb')).target,
    path.join(await realpath(linked), 'demo.ipynb'),
  )
  await assert.rejects(
    resolveExistingFile(ctx, 's1', path.join(main, 'demo.ipynb')),
    (error) => error.code === 'path-outside-root',
    'the former root is no longer authorized',
  )

  events = [...events, { seq: 2, type: 'working-directory/change', data: { cwd: main } }]
  assert.equal(await resolveWorkspace(ctx, 's1'), await realpath(main), 'a newer committed directory change ends the worktree evidence')
  assert.equal(
    (await resolveExistingFile(ctx, 's1', 'demo.ipynb')).target,
    path.join(await realpath(main), 'demo.ipynb'),
  )
})

test('an ordinary directory and an explicit host override follow different trust rules', async (t) => {
  const root = await tempDir(t, 'dsh-ipynb-active-root-override-')
  const main = path.join(root, 'main')
  const other = path.join(root, 'other')
  await mkdir(main)
  await mkdir(other)
  await writeFile(path.join(other, 'demo.ipynb'), '{}')
  const session = {
    header: { cwd: main },
    seq: 1,
    snapshotEvents: () => [{ seq: 1, type: 'tool/call', data: { cwd: other } }],
  }
  const ctx = { sessions: { get: () => session } }
  assert.equal(await resolveWorkspace(ctx, 's1'), await realpath(main), 'a non-Git directory is not a linked worktree')

  const previous = process.env.DSH_SIDEBAR_WORKTREE_ROOT
  process.env.DSH_SIDEBAR_WORKTREE_ROOT = other
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_SIDEBAR_WORKTREE_ROOT
    else process.env.DSH_SIDEBAR_WORKTREE_ROOT = previous
  })
  assert.equal(await resolveWorkspace(ctx, 's1'), await realpath(other), 'the host-owned override matches Better Sidebar')
  assert.equal(
    (await resolveExistingFile(ctx, 's1', 'demo.ipynb')).target,
    path.join(await realpath(other), 'demo.ipynb'),
  )
})
