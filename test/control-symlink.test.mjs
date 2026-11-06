import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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

async function setup(t, kind, { outside = false } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-control-symlink-'))
  const workspace = path.join(temporary, 'workspace')
  const outsideWorkspace = path.join(temporary, 'outside')
  await Promise.all([mkdir(workspace), mkdir(outsideWorkspace)])
  const anchor = outside ? outsideWorkspace : workspace
  let requestedPath
  let target
  let removeTarget
  if (kind === 'file') {
    target = path.join(anchor, 'real.ipynb')
    await writeFile(target, JSON.stringify(notebook))
    requestedPath = 'linked.ipynb'
    await symlink(path.relative(workspace, target), path.join(workspace, requestedPath), 'file')
    removeTarget = () => rm(target)
  } else {
    const realDirectory = path.join(anchor, 'real-directory')
    await mkdir(realDirectory)
    target = path.join(realDirectory, 'notebook.ipynb')
    await writeFile(target, JSON.stringify(notebook))
    await symlink(path.relative(workspace, realDirectory), path.join(workspace, 'linked-directory'), 'dir')
    requestedPath = 'linked-directory/notebook.ipynb'
    removeTarget = () => rm(realDirectory, { recursive: true })
  }
  const canonicalTarget = await realpath(target)
  const priorPython = process.env.DSH_IPYNB_PYTHON
  process.env.DSH_IPYNB_PYTHON = process.execPath
  resetInterpreterCache()
  t.after(async () => {
    if (priorPython === undefined) delete process.env.DSH_IPYNB_PYTHON
    else process.env.DSH_IPYNB_PYTHON = priorPython
    resetInterpreterCache()
    await rm(temporary, { recursive: true, force: true })
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
  registerIpynbRoutes({
    sessions: { get: (sessionId) => sessionId === 's1' ? { header: { cwd: workspace } } : undefined },
    connection: { requestRejection: () => undefined },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }, kernels)
  async function invoke(operation) {
    const body = {
      sessionId: 's1', path: requestedPath, cellId: 'cell', code: '1',
      notebook, baseVersion: '0'.repeat(64), python: process.execPath,
    }
    const request = {
      method: operation === 'status' ? 'GET' : 'POST',
      url: operation === 'status'
        ? `/ipynb/status?${new URLSearchParams({ sessionId: 's1', path: requestedPath })}`
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
    const started = await invoke('execute')
    assert.equal(started.status, 200)
    assert.deepEqual([...entries.keys()], [canonicalTarget], 'execution must initially register the real path')
  }
  calls.length = 0
  await removeTarget()
  return { invoke, calls, entries, canonicalTarget }
}

for (const kind of ['file', 'directory']) {
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
}
