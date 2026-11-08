import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernelManager } from '../lib/kernel.js'
import { findPython, tempDir } from './python-helper.mjs'

const bridgePath = fileURLToPath(new URL('../python/bridge.py', import.meta.url))
const python = findPython('jupyter_client, ipykernel')
const skip = !python && 'Requires jupyter_client/ipykernel'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function within(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label || 'timed out')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function waitFor(predicate, ms = 5_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(50)
  }
  throw new Error('condition was not met in time')
}

async function makeTarget(t, name) {
  const dir = await tempDir(t, 'dsh-bsb-ipynb-kernel-')
  return path.join(dir, name)
}

test('a second execute is rejected without stealing the first listener', { skip }, async (t) => {
  const manager = new KernelManager({}, bridgePath)
  const target = await makeTarget(t, 'overlap.ipynb')
  try {
    const entry = await manager.getOrStart(target, python)
    const firstEvents = []
    const first = entry.run('c1', 'import time\ntime.sleep(0.5)\nprint("first")', (event) => firstEvents.push(event))
    assert.equal(entry.busy, true, 'the first run marks the kernel busy')
    await assert.rejects(entry.run('c2', '1'), (error) => error.code === 'kernel-busy')
    const reply = await within(first, 10_000, 'first execution did not settle')
    assert.equal(reply.cell_id, 'c1')
    assert.equal(reply.ok, true)
    assert.ok(firstEvents.some((event) => event.type === 'stream' && event.text === 'first\n'))
    assert.ok(firstEvents.some((event) => event.type === 'execute_reply' && event.cell_id === 'c1'))
    assert.ok(!firstEvents.some((event) => event.cell_id === 'c2'))
  } finally {
    await manager.disposeAll()
  }
})

test('shutdown and os._exit settle the running cell', { skip }, async (t) => {
  const manager = new KernelManager({}, bridgePath)
  const firstTarget = await makeTarget(t, 'shutdown.ipynb')
  const secondTarget = await makeTarget(t, 'exit.ipynb')
  try {
    const entry = await manager.getOrStart(firstTarget, python)
    const firstEvents = []
    const run = entry.run('c1', 'import time\nprint("started", flush=True)\ntime.sleep(5)', (event) => firstEvents.push(event))
    await waitFor(() => firstEvents.some((event) => event.type === 'stream' && event.text.includes('started')), 10_000)
    await manager.shutdown(firstTarget)
    const stopped = await within(run, 5_000, 'shutdown did not settle the running cell')
    assert.equal(stopped.ok, false)

    const exitEntry = await manager.getOrStart(secondTarget, python)
    const events = []
    const exited = await within(
      exitEntry.run('c2', 'import os\nos._exit(7)', (event) => events.push(event)),
      10_000,
      'os._exit did not settle the running cell',
    )
    assert.equal(exited.ok, false)
    assert.ok(events.some((event) => event.type === 'kernel_died'))
    await waitFor(() => manager.status(secondTarget).running === false)
  } finally {
    await manager.disposeAll()
  }
})

test('a hard-killed bridge leaves no connection file behind', { skip }, async (t) => {
  const manager = new KernelManager({}, bridgePath)
  const target = await makeTarget(t, 'connection-file.ipynb')
  try {
    const entry = await manager.getOrStart(target, python)
    const connectionFile = entry.connectionFile
    assert.ok(connectionFile, 'the host chooses the connection file path')
    assert.equal(existsSync(connectionFile), true)
    // TerminateProcess on Windows (SIGTERM elsewhere) prevents the bridge from
    // cleaning up; the host exit handler must remove the file.
    entry.proc.kill('SIGTERM')
    await waitFor(() => manager.status(target).running === false)
    await waitFor(() => !existsSync(connectionFile), 3000)
  } finally {
    await manager.disposeAll()
  }
})

// The stdin-failure, synchronous-write-failure and concurrent-getOrStart
// coverage moved to test/kernel-lifecycle.test.mjs's fake-child harness (B-1),
// where it asserts the same entry state without spawning real Python.

// Merged from the former "restart settles a running cell and leaves a usable
// kernel" test: this stronger variant keeps its unique restart assertions (the
// interrupted run receives an error event and the restarted kernel accepts the
// next execute) on top of the exec-id identity checks.
test('restart settles the running cell and exec ids keep the restarted cell from stealing the next run', { skip }, async (t) => {
  const manager = new KernelManager({}, bridgePath)
  const target = await makeTarget(t, 'exec-id.ipynb')
  try {
    const entry = await manager.getOrStart(target, python)
    const oldEvents = []
    const oldRun = entry.run('same-cell', 'import time\ntime.sleep(5)\nprint("old")', (event) => oldEvents.push(event))
    await waitFor(() => oldEvents.some((event) => event.type === 'status' && event.execution_state === 'busy'), 10_000)
    const restarting = entry.restart()
    assert.equal(entry.ready, false)
    const newEvents = []
    const newRun = entry.run('same-cell', 'print("new")', (event) => newEvents.push(event))
    await within(restarting, 15_000, 'restart did not finish')
    assert.equal(entry.ready, true)
    const oldReply = await within(oldRun, 5_000, 'old run was not settled by restart')
    assert.equal(oldReply.ok, false)
    assert.ok(oldEvents.some((event) => event.type === 'error'), 'the interrupted run receives an error event')
    const newReply = await within(newRun, 15_000, 'second run after restart did not settle')
    assert.equal(newReply.ok, true)
    assert.equal(newReply.cell_id, 'same-cell')
    await sleep(200)
    assert.ok(newEvents.some((event) => event.type === 'stream' && event.text === 'new\n'))
    assert.ok(!newEvents.some((event) => event.type === 'stream' && event.text === 'old\n'))
    assert.ok(!oldEvents.some((event) => event.type === 'stream'))
    const ids = newEvents.filter((event) => typeof event.exec_id === 'string').map((event) => event.exec_id)
    assert.ok(ids.length > 0)
    assert.equal(new Set(ids).size, 1)
  } finally {
    await manager.disposeAll()
  }
})

// The oversized-line coverage lives in test/kernel-lifecycle.test.mjs's M-16
// fake-child tests (64 MiB boundary, UTF-8 accounting and restart-only-once),
// which do not need a real Python kernel to produce the byte flood.

test('DSH_IPYNB_KERNEL_IDLE_MS=0 disables the idle sweep', async (t) => {
  const previous = process.env.DSH_IPYNB_KERNEL_IDLE_MS
  const manager = new KernelManager({}, bridgePath)
  t.after(async () => {
    await manager.disposeAll()
    if (previous === undefined) delete process.env.DSH_IPYNB_KERNEL_IDLE_MS
    else process.env.DSH_IPYNB_KERNEL_IDLE_MS = previous
  })
  const shutdowns = []
  manager.entries.set('idle-target', {
    busy: false,
    startPromise: null,
    restartPromise: null,
    stopping: false,
    lastActivity: 0,
    async shutdown() { shutdowns.push('shutdown') },
  })
  process.env.DSH_IPYNB_KERNEL_IDLE_MS = '0'
  await manager.sweepIdle()
  assert.deepEqual(shutdowns, [], '0 disables the idle sweep')
  process.env.DSH_IPYNB_KERNEL_IDLE_MS = '1000'
  await manager.sweepIdle()
  assert.deepEqual(shutdowns, ['shutdown'], 'a positive TTL still sweeps idle kernels')
  assert.equal(manager.entries.has('idle-target'), false)
})
