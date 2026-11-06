import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernelManager, exceedsMaxLineBytes } from '../lib/kernel.js'

const bridgePath = fileURLToPath(new URL('../python/bridge.py', import.meta.url))
const python = process.env.DSH_IPYNB_TEST_PYTHON || '/opt/miniconda3/bin/python3'

function hasJupyter(executable) {
  const result = spawnSync(executable, ['-c', 'import jupyter_client, ipykernel'], { timeout: 10_000 })
  return result.status === 0
}

const skip = !hasJupyter(python)

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

async function makeTarget(name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bsb-ipynb-kernel-'))
  return path.join(dir, name)
}

test('a second execute is rejected without stealing the first listener', { skip }, async () => {
  const manager = new KernelManager({}, bridgePath)
  const target = await makeTarget('overlap.ipynb')
  try {
    const entry = await manager.getOrStart(target, python)
    const firstEvents = []
    const first = entry.run('c1', 'import time\ntime.sleep(0.5)\nprint("first")', (event) => firstEvents.push(event))
    await sleep(100)
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

test('restart settles a running cell and leaves a usable kernel', { skip }, async () => {
  const manager = new KernelManager({}, bridgePath)
  const target = await makeTarget('restart.ipynb')
  try {
    const entry = await manager.getOrStart(target, python)
    const events = []
    const run = entry.run('c1', 'import time\ntime.sleep(5)\nprint("late")', (event) => events.push(event))
    await sleep(300)
    await entry.restart()
    const reply = await within(run, 5_000, 'restart did not settle the running cell')
    assert.equal(reply.ok, false)
    assert.ok(events.some((event) => event.type === 'error'))
    const after = await within(entry.run('c2', 'print("after")', () => {}), 15_000, 'kernel was not usable after restart')
    assert.equal(after.ok, true)
  } finally {
    await manager.disposeAll()
  }
})

test('shutdown and os._exit settle the running cell', { skip }, async () => {
  const manager = new KernelManager({}, bridgePath)
  const firstTarget = await makeTarget('shutdown.ipynb')
  const secondTarget = await makeTarget('exit.ipynb')
  try {
    const entry = await manager.getOrStart(firstTarget, python)
    const run = entry.run('c1', 'import time\ntime.sleep(5)', () => {})
    await sleep(300)
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

test('a broken stdin pipe is handled instead of crashing the host', { skip }, async () => {
  const manager = new KernelManager({}, bridgePath)
  const target = await makeTarget('epipe.ipynb')
  try {
    const entry = await manager.getOrStart(target, python)
    entry.proc.stdin.destroy(new Error('write EPIPE'))
    await sleep(300)
    assert.equal(entry.ready, false)
    await assert.rejects(entry.run('c1', '1'), (error) => error.code === 'kernel-unavailable')
    assert.equal(entry.busy, false)
  } finally {
    await manager.disposeAll()
  }
})

test('a synchronous stdin write failure clears the busy execution state', { skip }, async () => {
  const manager = new KernelManager({}, bridgePath)
  const target = await makeTarget('write-failure.ipynb')
  let stdin
  let originalWrite
  try {
    const entry = await manager.getOrStart(target, python)
    stdin = entry.proc.stdin
    originalWrite = stdin.write
    stdin.write = () => {
      throw new Error('simulated write failure')
    }
    await assert.rejects(entry.run('c1', '1'), (error) => error.code === 'kernel-unavailable')
    assert.equal(entry.currentRun, null)
    assert.equal(entry.busy, false)
    assert.equal(entry.executionState, 'dead')
  } finally {
    if (stdin && originalWrite) stdin.write = originalWrite
    await manager.disposeAll()
  }
})

test('concurrent getOrStart creates only one kernel entry', { skip }, async () => {
  const manager = new KernelManager({}, bridgePath)
  const target = await makeTarget('shared.ipynb')
  try {
    const [first, second] = await Promise.all([
      manager.getOrStart(target, python),
      manager.getOrStart(target, python),
    ])
    assert.equal(first, second)
    assert.equal(manager.kernelCount, 1)
    const events = []
    const reply = await within(first.run('c1', 'print("shared")', (event) => events.push(event)), 10_000, 'shared execution did not settle')
    assert.equal(reply.ok, true)
    assert.ok(events.some((event) => event.type === 'stream' && event.text.includes('shared')))
  } finally {
    await manager.disposeAll()
  }
})

test('exec ids keep a restarted cell from stealing the next run', { skip }, async () => {
  const manager = new KernelManager({}, bridgePath)
  const target = await makeTarget('exec-id.ipynb')
  try {
    const entry = await manager.getOrStart(target, python)
    const oldEvents = []
    const oldRun = entry.run('same-cell', 'import time\ntime.sleep(5)\nprint("old")', (event) => oldEvents.push(event))
    await sleep(300)
    const restarting = entry.restart()
    assert.equal(entry.ready, false)
    const newEvents = []
    const newRun = entry.run('same-cell', 'print("new")', (event) => newEvents.push(event))
    await within(restarting, 15_000, 'restart did not finish')
    assert.equal(entry.ready, true)
    const oldReply = await within(oldRun, 5_000, 'old run was not settled by restart')
    assert.equal(oldReply.ok, false)
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

test('an oversized stdout line aborts the running cell and restarts the kernel', { skip }, async () => {
  const manager = new KernelManager({}, bridgePath)
  const target = await makeTarget('oversize.ipynb')
  try {
    const entry = await manager.getOrStart(target, python)
    const events = []
    const run = entry.run('big', 'import time\ntime.sleep(5)', (event) => events.push(event))
    await sleep(300)
    // Simulate a byte flood without materializing 64 MiB in the test.
    entry.stdoutBytes = 64 * 1024 * 1024
    entry.handleStdout('x')
    const reply = await within(run, 5_000, 'oversized output did not settle the run')
    assert.equal(reply.ok, false)
    assert.match(entry.lastError, /exceeded 64 MiB/)
    assert.ok(events.some((event) => event.type === 'fatal' && event.code === 'too-large'))
    await within(entry.ensureStarted(), 15_000, 'kernel did not come back after oversized output')
    assert.equal(entry.ready, true)
    const after = await within(entry.run('after', 'print("after")', () => {}), 15_000, 'kernel unusable after oversized output')
    assert.equal(after.ok, true)
  } finally {
    await manager.disposeAll()
  }
})

test('the oversized-line helper uses a strict byte boundary', () => {
  assert.equal(exceedsMaxLineBytes(64 * 1024 * 1024), false)
  assert.equal(exceedsMaxLineBytes(64 * 1024 * 1024 + 1), true)
})
