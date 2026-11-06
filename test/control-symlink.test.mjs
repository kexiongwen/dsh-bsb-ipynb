import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promises as fsp } from 'node:fs'
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

// Keep real routing, filesystem resolution, and interpreter selection, while
// avoiding a Python/Jupyter requirement for these path-identity regressions.
const originalExecFile = childProcess.execFile
const mockExecFile = () => { throw new Error('Unexpected callback-style interpreter probe') }
mockExecFile[promisify.custom] = async () => ({
  stdout: JSON.stringify({ ok: true, version: '3.14', jupyter_client: 'test', ipykernel: 'test' }),
  stderr: '',
})
let registerIpynbRoutes
let resetInterpreterCache
try {
  childProcess.execFile = mockExecFile
  syncBuiltinESMExports()
  ;({ registerIpynbRoutes } = await import('../lib/routes.js'))
  ;({ resetInterpreterCache } = await import('../lib/env.js'))
} finally {
  childProcess.execFile = originalExecFile
  syncBuiltinESMExports()
}

const notebook = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }

async function setup(t, kind, {
  outside = false, caseMismatch = false, absolute = false,
  removeAfterStart = true, directCaseMismatch = false, executeCanonical = false,
} = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-control-symlink-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const workspace = path.join(temporary, 'workspace')
  const outsideWorkspace = path.join(temporary, 'outside')
  await Promise.all([mkdir(workspace), mkdir(outsideWorkspace)])
  const anchor = outside ? outsideWorkspace : workspace
  let requestedPath
  let target
  let removeTarget
  if (kind === 'file') {
    target = path.join(anchor, caseMismatch ? 'Actual.ipynb' : 'real.ipynb')
    await writeFile(target, JSON.stringify(notebook))
    requestedPath = 'linked.ipynb'
    const linkTarget = caseMismatch ? path.join(anchor, 'actual.ipynb') : target
    if (caseMismatch && !await sameExistingPath(target, linkTarget)) {
      t.skip('Requires a case-insensitive filesystem for the real symlink spelling regression')
      return null
    }
    await symlink(path.relative(workspace, linkTarget), path.join(workspace, requestedPath), 'file')
    removeTarget = () => rm(target)
  } else {
    const realDirectory = path.join(anchor, caseMismatch ? 'ActualDirectory' : 'real-directory')
    await mkdir(realDirectory)
    target = path.join(realDirectory, 'notebook.ipynb')
    await writeFile(target, JSON.stringify(notebook))
    const linkTarget = caseMismatch ? path.join(anchor, 'actualdirectory') : realDirectory
    if (caseMismatch && !await sameExistingPath(realDirectory, linkTarget)) {
      t.skip('Requires a case-insensitive filesystem for the real directory spelling regression')
      return null
    }
    await symlink(path.relative(workspace, linkTarget), path.join(workspace, 'linked-directory'), 'dir')
    requestedPath = 'linked-directory/notebook.ipynb'
    removeTarget = () => rm(realDirectory, { recursive: true })
  }
  const linkPath = path.join(workspace, kind === 'file' ? 'linked.ipynb' : 'linked-directory')
  if (directCaseMismatch) requestedPath = kind === 'file' ? 'actual.ipynb' : 'actualdirectory/notebook.ipynb'
  if (absolute) requestedPath = path.join(workspace, requestedPath)
  const canonicalTarget = await realpath(target)
  const priorPython = process.env.DSH_IPYNB_PYTHON
  process.env.DSH_IPYNB_PYTHON = process.execPath
  resetInterpreterCache()
  t.after(async () => {
    if (priorPython === undefined) delete process.env.DSH_IPYNB_PYTHON
    else process.env.DSH_IPYNB_PYTHON = priorPython
    resetInterpreterCache()
  })

  const calls = []
  const entries = new Map()
  const makeEntry = (entryTarget, python) => ({
    python,
    busy: false,
    async run(cellId, code, onEvent) {
      calls.push({ operation: 'execute', target: entryTarget })
      const reply = { type: 'execute_reply', cell_id: cellId, ok: true }
      onEvent(reply)
      return reply
    },
    async interrupt() { calls.push({ operation: 'interrupt', target: entryTarget }) },
  })
  const kernels = {
    status(entryTarget) {
      calls.push({ operation: 'status', target: entryTarget })
      return { running: entries.has(entryTarget), ready: entries.has(entryTarget), busy: false }
    },
    peek(entryTarget) { return entries.get(entryTarget) || null },
    async getOrStart(entryTarget, python) {
      calls.push({ operation: 'getOrStart', target: entryTarget })
      if (!entries.has(entryTarget)) {
        calls.push({ operation: 'create', target: entryTarget })
        entries.set(entryTarget, makeEntry(entryTarget, python))
      }
      return entries.get(entryTarget)
    },
    async restart(entryTarget) {
      calls.push({ operation: 'restart', target: entryTarget })
      assert.ok(entries.has(entryTarget), 'restart must address an existing exact kernel key')
      return entries.get(entryTarget)
    },
    async shutdown(entryTarget) {
      calls.push({ operation: 'shutdown', target: entryTarget })
      return entries.delete(entryTarget)
    },
  }
  let handler
  const sessions = new Map([['s1', { header: { cwd: workspace } }]])
  registerIpynbRoutes({
    sessions: { get: (sessionId) => sessions.get(sessionId) },
    connection: { requestRejection: () => undefined },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }, kernels)
  async function invoke(operation, overrides = {}) {
    const body = {
      sessionId: 's1', path: requestedPath, cellId: 'cell', code: '1',
      notebook, baseVersion: '0'.repeat(64), python: process.execPath,
      ...overrides,
    }
    const request = {
      method: operation === 'status' ? 'GET' : 'POST',
      url: operation === 'status'
        ? `/ipynb/status?${new URLSearchParams({ sessionId: body.sessionId, path: body.path })}`
        : `/ipynb/${operation}`,
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {
        if (operation !== 'status') yield Buffer.from(JSON.stringify(body))
      },
    }
    const res = new EventEmitter()
    Object.assign(res, {
      headersSent: false,
      status: 0,
      headers: {},
      chunks: [],
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true },
      write(chunk) { this.chunks.push(String(chunk)); return true },
      end(chunk) { if (chunk !== undefined) this.chunks.push(String(chunk)) },
    })
    await handler(request, res)
    return {
      status: res.status,
      body: String(res.headers['content-type']).includes('application/json')
        ? JSON.parse(res.chunks.join(''))
        : null,
    }
  }

  if (outside) {
    // Represents a kernel legitimately started by a different workspace. The
    // current session must never reach it through its own dangling symlink.
    entries.set(canonicalTarget, makeEntry(canonicalTarget, await realpath(process.execPath)))
  } else {
    const started = await invoke('execute', executeCanonical ? { path: canonicalTarget } : {})
    assert.equal(started.status, 200)
    assert.deepEqual([...entries.keys()], [canonicalTarget], 'execution must initially register the real path')
  }
  calls.length = 0
  if (removeAfterStart) await removeTarget()
  return { invoke, calls, entries, canonicalTarget, temporary, workspace, outsideWorkspace, target, linkPath, requestedPath, removeTarget, sessions }
}

async function sameExistingPath(first, second) {
  try {
    return await realpath(first) === await realpath(second)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function assertDoesNotReachOriginal(h, overrides = {}) {
  h.calls.length = 0
  const status = await h.invoke('status', overrides)
  assert.equal(status.status, 200)
  assert.equal(status.body?.value?.running, false, 'an unrelated spelling must not inherit the old alias')
  for (const operation of ['interrupt', 'restart', 'shutdown']) await h.invoke(operation, overrides)
  assert.equal(h.calls.some((call) => call.target === h.canonicalTarget), false,
    'no lookup, restart, or shutdown may address the old canonical entry')
  assert.equal(h.entries.has(h.canonicalTarget), true, 'the original kernel must remain untouched')
}

for (const kind of ['file', 'directory']) {
  test(`controls preserve canonical spelling after a case-mismatched ${kind} symlink target is deleted`, async (t) => {
    const h = await setup(t, kind, { caseMismatch: true })
    if (!h) return
    const status = await h.invoke('status')
    const interrupt = await h.invoke('interrupt')
    const restart = await h.invoke('restart')
    const shutdown = await h.invoke('shutdown')
    const targets = (operation) => h.calls.filter((call) => call.operation === operation).map((call) => call.target)
    assert.deepEqual({
      statuses: [status.status, interrupt.status, restart.status, shutdown.status],
      running: status.body?.value?.running,
      statusTargets: targets('status'),
      interruptTargets: targets('interrupt'),
      restartTargets: targets('restart'),
      shutdownTargets: targets('shutdown'),
      createdTargets: targets('create'),
      remainingKeys: [...h.entries.keys()],
    }, {
      statuses: [200, 200, 200, 200],
      running: true,
      statusTargets: [h.canonicalTarget],
      interruptTargets: [h.canonicalTarget],
      restartTargets: [h.canonicalTarget],
      shutdownTargets: [h.canonicalTarget],
      createdTargets: [],
      remainingKeys: [],
    })
  })

  test(`controls retain the original kernel identity after a ${kind} symlink target is deleted`, async (t) => {
    const h = await setup(t, kind)
    const status = await h.invoke('status')
    const interrupt = await h.invoke('interrupt')
    const restart = await h.invoke('restart')
    const shutdown = await h.invoke('shutdown')
    const targets = (operation) => h.calls.filter((call) => call.operation === operation).map((call) => call.target)
    assert.deepEqual({
      statuses: [status.status, interrupt.status, restart.status, shutdown.status],
      running: status.body?.value?.running,
      statusTargets: targets('status'),
      interruptTargets: targets('interrupt'),
      restartTargets: targets('restart'),
      shutdownTargets: targets('shutdown'),
      createdTargets: targets('create'),
      remainingKeys: [...h.entries.keys()],
    }, {
      statuses: [200, 200, 200, 200],
      running: true,
      statusTargets: [h.canonicalTarget],
      interruptTargets: [h.canonicalTarget],
      restartTargets: [h.canonicalTarget],
      shutdownTargets: [h.canonicalTarget],
      createdTargets: [],
      remainingKeys: [],
    })
  })

  test(`a dangling ${kind} symlink outside the workspace cannot control another kernel`, async (t) => {
    const h = await setup(t, kind, { outside: true })
    const results = []
    for (const operation of ['status', 'interrupt', 'restart', 'shutdown']) {
      const result = await h.invoke(operation)
      results.push({ operation, status: result.status, code: result.body?.error?.code })
    }
    assert.deepEqual(results, ['status', 'interrupt', 'restart', 'shutdown'].map((operation) => ({
      operation, status: 403, code: 'path-outside-root',
    })))
    assert.deepEqual(h.calls, [], 'authorization must reject before any kernel lookup or control')
    assert.deepEqual([...h.entries.keys()], [h.canonicalTarget])
  })

  test(`read, save and execute still require the missing target behind a ${kind} symlink`, async (t) => {
    const h = await setup(t, kind)
    const results = []
    for (const operation of ['read', 'save', 'execute']) {
      const result = await h.invoke(operation)
      results.push({ operation, status: result.status, code: result.body?.error?.code })
    }
    assert.deepEqual(results, [
      { operation: 'read', status: 404, code: 'not-found' },
      { operation: 'save', status: 409, code: 'write-conflict' },
      { operation: 'execute', status: 404, code: 'not-found' },
    ])
    assert.deepEqual(h.calls, [])
    assert.deepEqual([...h.entries.keys()], [h.canonicalTarget])
  })

  test(`deleted ${kind} target spelling aliases are scoped to the session that observed them`, async (t) => {
    const h = await setup(t, kind, { caseMismatch: true })
    if (!h) return
    h.sessions.set('s2', { header: { cwd: h.workspace } })
    await assertDoesNotReachOriginal(h, { sessionId: 's2' })
    // Kernel ownership remains path-based. Only the spelling history is
    // session-scoped: a different authorized session may use the exact key.
    const exact = await h.invoke('status', { sessionId: 's2', path: h.canonicalTarget })
    assert.equal(exact.body?.value?.running, true)
    assert.equal((await h.invoke('interrupt', { sessionId: 's2', path: h.canonicalTarget })).status, 200)
    const original = await h.invoke('status')
    assert.equal(original.body?.value?.running, true, 'another session must not evict the original session alias')
  })

  test(`deleted ${kind} target spelling aliases do not survive a session workspace change`, async (t) => {
    const h = await setup(t, kind, { caseMismatch: true, absolute: true })
    if (!h) return
    // Keep the exact absolute request within the new root, so containment
    // alone cannot hide an incorrectly session-only alias key.
    h.sessions.get('s1').header.cwd = h.temporary
    await assertDoesNotReachOriginal(h)
  })

  for (const change of ['redirected', 'removed', 'removed and recreated']) {
    test(`a ${change} ${kind} symlink cannot recover the former spelling alias`, async (t) => {
      const h = await setup(t, kind, { caseMismatch: true })
      if (!h) return
      const oldLink = await readlink(h.linkPath)
      await rm(h.linkPath)
      if (change === 'redirected') {
        await symlink(kind === 'file' ? 'other.ipynb' : 'other-directory', h.linkPath, kind === 'file' ? 'file' : 'dir')
      } else if (change === 'removed and recreated') {
        // Occupy a freshly allocated symlink identity before recreating the
        // requested link, avoiding accidental inode reuse in the fixture.
        await symlink('unused', h.linkPath + '.identity-guard', 'file')
        await symlink(oldLink, h.linkPath, kind === 'file' ? 'file' : 'dir')
      }
      await assertDoesNotReachOriginal(h)
    })
  }

  test(`a reappearing ${kind} target uses its current canonical spelling instead of a cached alias`, async (t) => {
    const h = await setup(t, kind, { caseMismatch: true })
    if (!h) return
    const recreatedTarget = kind === 'file'
      ? path.join(h.workspace, 'actual.ipynb')
      : path.join(h.workspace, 'actualdirectory', 'notebook.ipynb')
    if (kind === 'directory') await mkdir(path.dirname(recreatedTarget))
    await writeFile(recreatedTarget, JSON.stringify(notebook))
    const newCanonical = await realpath(recreatedTarget)
    assert.notEqual(newCanonical, h.canonicalTarget)
    await assertDoesNotReachOriginal(h)
    assert.ok(h.calls.some((call) => call.operation === 'create' && call.target === newCanonical),
      'restart must select the current real file identity')
  })

  test(`a remembered ${kind} symlink redirected outside the workspace is rejected before kernel access`, async (t) => {
    const h = await setup(t, kind, { caseMismatch: true })
    if (!h) return
    await rm(h.linkPath)
    const outsideTarget = path.join(h.outsideWorkspace, kind === 'file' ? 'missing.ipynb' : 'missing-directory')
    await symlink(path.relative(h.workspace, outsideTarget), h.linkPath, kind === 'file' ? 'file' : 'dir')
    h.calls.length = 0
    for (const operation of ['status', 'interrupt', 'restart', 'shutdown']) {
      const result = await h.invoke(operation)
      assert.equal(result.status, 403)
      assert.equal(result.body?.error?.code, 'path-outside-root')
    }
    assert.deepEqual(h.calls, [], 'cached identity must not bypass current workspace containment')
    assert.deepEqual([...h.entries.keys()], [h.canonicalTarget])
  })

  test(`interpreter replacement through a deleted ${kind} target preserves its authorized alias`, async (t) => {
    const h = await setup(t, kind, { caseMismatch: true })
    if (!h) return
    const oldEntry = h.entries.get(h.canonicalTarget)
    oldEntry.python = '/different-interpreter'
    assert.equal((await h.invoke('restart')).status, 200)
    const replacement = h.entries.get(h.canonicalTarget)
    assert.ok(replacement)
    assert.notEqual(replacement, oldEntry, 'switching interpreter must actually replace the mocked entry')
    assert.equal((await h.invoke('status')).body?.value?.running, true)
    assert.equal((await h.invoke('interrupt')).status, 200)
    assert.equal((await h.invoke('shutdown')).status, 200)
    assert.ok(h.calls.every((call) => call.target === h.canonicalTarget))
    assert.deepEqual(h.calls.filter((call) => call.operation === 'create').map((call) => call.target), [h.canonicalTarget])
    assert.equal(h.entries.size, 0)
  })

  for (const change of ['closed', 'replaced']) {
    test(`a ${change} kernel entry cannot pass its deleted ${kind} target alias to another lifecycle`, async (t) => {
      const h = await setup(t, kind, { caseMismatch: true })
      if (!h) return
      const oldEntry = h.entries.get(h.canonicalTarget)
      if (change === 'closed') h.entries.delete(h.canonicalTarget)
      else h.entries.set(h.canonicalTarget, { ...oldEntry })
      const status = await h.invoke('status')
      assert.equal(status.body?.value?.running, false)
      for (const operation of ['interrupt', 'restart', 'shutdown']) await h.invoke(operation)
      assert.equal(h.calls.some((call) => call.target === h.canonicalTarget), false,
        'a stale alias cannot address or create a kernel at the previous canonical key')
      assert.equal(h.entries.has(h.canonicalTarget), change === 'replaced')
    })
  }

  test(`a direct case-mismatched ${kind} path retains its canonical key after deletion without a symlink`, async (t) => {
    const h = await setup(t, kind, { caseMismatch: true, directCaseMismatch: true })
    if (!h) return
    assert.equal((await h.invoke('status')).body?.value?.running, true)
    for (const operation of ['interrupt', 'restart', 'shutdown']) {
      assert.equal((await h.invoke(operation)).status, 200)
    }
    assert.ok(h.calls.every((call) => call.target === h.canonicalTarget))
    assert.equal(h.calls.some((call) => call.operation === 'create'), false)
    assert.equal(h.entries.size, 0)
  })

  test(`status can remember a live kernel's ${kind} alias before the target disappears`, async (t) => {
    const h = await setup(t, kind, { caseMismatch: true, removeAfterStart: false, executeCanonical: true })
    if (!h) return
    assert.equal((await h.invoke('status')).body?.value?.running, true,
      'the alias is observed by status, not by its own execute request')
    await h.removeTarget()
    h.calls.length = 0
    assert.equal((await h.invoke('status')).body?.value?.running, true)
    for (const operation of ['interrupt', 'restart', 'shutdown']) {
      assert.equal((await h.invoke(operation)).status, 200)
    }
    assert.ok(h.calls.every((call) => call.target === h.canonicalTarget))
    assert.equal(h.calls.some((call) => call.operation === 'create'), false)
    assert.equal(h.entries.size, 0)
  })
}

test('case-sensitive files with distinct names remain distinct kernel keys, including after one is deleted', async (t) => {
  const h = await setup(t, 'file', { removeAfterStart: false })
  h.entries.clear()
  h.calls.length = 0
  const root = await realpath(h.workspace)
  const upper = path.join(root, 'Actual.ipynb')
  const lower = path.join(root, 'actual.ipynb')
  const liveFiles = new Set([upper, lower])
  const templateStat = await lstat(h.target)
  const virtualStats = new Map([upper, lower].map((file, index) => {
    const stat = Object.create(templateStat)
    stat.ino = templateStat.ino + index + 1
    return [file, stat]
  }))
  // A tiny exact-case filesystem overlay keeps this regression active on
  // macOS as well as Linux, without mounting a volume or lowercasing paths.
  for (const method of ['realpath', 'stat', 'lstat']) {
    const original = fsp[method].bind(fsp)
    t.mock.method(fsp, method, async (candidate, ...args) => {
      if (candidate !== upper && candidate !== lower) return original(candidate, ...args)
      if (!liveFiles.has(candidate)) {
        const error = new Error('missing simulated case-sensitive file')
        error.code = 'ENOENT'
        throw error
      }
      return method === 'realpath' ? candidate : virtualStats.get(candidate)
    })
  }
  assert.equal((await h.invoke('execute', { path: upper })).status, 200)
  assert.equal((await h.invoke('execute', { path: lower })).status, 200)
  assert.deepEqual([...h.entries.keys()].sort(), [upper, lower].sort())
  liveFiles.delete(upper)
  h.calls.length = 0
  assert.equal((await h.invoke('status', { path: upper })).body?.value?.running, true)
  assert.equal((await h.invoke('interrupt', { path: upper })).status, 200)
  assert.equal((await h.invoke('restart', { path: upper })).status, 200)
  assert.equal((await h.invoke('shutdown', { path: upper })).status, 200)
  assert.ok(h.calls.every((call) => call.target === upper), 'controls for Actual.ipynb must never select actual.ipynb')
  assert.deepEqual([...h.entries.keys()], [lower])
  assert.equal((await h.invoke('status', { path: lower })).body?.value?.running, true)
})

for (const initiator of ['another alias', 'the canonical path']) {
  test(`interpreter replacement through ${initiator} preserves every previously observed alias`, async (t) => {
    const h = await setup(t, 'file', { caseMismatch: true, removeAfterStart: false })
    if (!h) return
    const secondAlias = 'second-linked.ipynb'
    await symlink('actual.ipynb', path.join(h.workspace, secondAlias), 'file')
    const observed = await h.invoke('status', { path: secondAlias })
    assert.equal(observed.body?.value?.running, true, 'both aliases must be observed before deletion')
    await h.removeTarget()
    const oldEntry = h.entries.get(h.canonicalTarget)
    oldEntry.python = '/different-interpreter'
    h.calls.length = 0
    const initiatingPath = initiator === 'the canonical path' ? h.canonicalTarget : h.requestedPath
    assert.equal((await h.invoke('restart', { path: initiatingPath })).status, 200)
    const replacement = h.entries.get(h.canonicalTarget)
    assert.ok(replacement)
    assert.notEqual(replacement, oldEntry)
    assert.deepEqual(h.calls.filter((call) => call.operation === 'create').map((call) => call.target), [h.canonicalTarget],
      'the interpreter switch creates exactly one replacement at the canonical path')

    h.calls.length = 0
    assert.equal((await h.invoke('status', { path: secondAlias })).body?.value?.running, true,
      'an alias not used for the restart must follow the authorized replacement')
    for (const operation of ['interrupt', 'restart', 'shutdown']) {
      assert.equal((await h.invoke(operation, { path: secondAlias })).status, 200)
    }
    assert.ok(h.calls.every((call) => call.target === h.canonicalTarget))
    assert.equal(h.calls.some((call) => call.operation === 'create'), false,
      'control through the second alias must not create a duplicate lowercase kernel')
    assert.equal(h.entries.size, 0)
  })
}
