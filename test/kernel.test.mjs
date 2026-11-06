import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernelManager } from '../lib/kernel.js'

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
