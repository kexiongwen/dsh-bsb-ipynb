import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { KernelManager } from '../lib/kernel.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

function observe(promise) {
  const result = { status: 'pending', value: undefined, error: undefined }
  promise.then(
    (value) => Object.assign(result, { status: 'fulfilled', value }),
    (error) => Object.assign(result, { status: 'rejected', error }),
  )
  return result
}

// Exercise the real manager/entry and JSON-lines parser, controlling only the
// child process and ready timers. No Python installation or real ports needed.
function harness(t, { exitOnKill = true } = {}) {
  const processes = []
  const readyTimers = []
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const timeoutMock = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay !== 30_000) return originalSetTimeout(callback, delay, ...args)
    const timer = { active: true, unref() {}, callback: () => callback(...args) }
    readyTimers.push(timer)
    return timer
  })
  const clearMock = t.mock.method(globalThis, 'clearTimeout', (timer) => {
    if (readyTimers.includes(timer)) timer.active = false
    else originalClearTimeout(timer)
  })
  const spawnMock = t.mock.method(childProcess, 'spawn', () => {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdout.setEncoding = proc.stderr.setEncoding = () => {}
    proc.stdin = new EventEmitter()
    proc.stdin.destroyed = false
    proc.commands = []
    proc.kills = []
    proc.exitCode = null
    let exited = false
    proc.exit = (code = 0, signal = null) => {
      if (exited) return
      exited = true
      proc.exitCode = code
      proc.stdin.destroyed = true
      proc.emit('exit', code, signal)
    }
    proc.stdin.write = (line) => {
      const command = JSON.parse(line)
      proc.commands.push(command)
      if (command.op === 'shutdown') queueMicrotask(() => proc.exit())
      return true
    }
    proc.stdin.end = () => { proc.stdin.destroyed = true }
    proc.kill = (signal) => {
      proc.kills.push(signal)
      if (exitOnKill) queueMicrotask(() => proc.exit(null, signal))
      return true
    }
    proc.event = (event) => proc.stdout.emit('data', `${JSON.stringify(event)}\n`)
    processes.push(proc)
    return proc
  })
  syncBuiltinESMExports()
  const manager = new KernelManager({}, '/controlled/bridge.py')
  const target = '/controlled/notebook.ipynb'
  t.after(async () => {
    await manager.disposeAll()
    spawnMock.mock.restore()
    syncBuiltinESMExports()
    timeoutMock.mock.restore()
    clearMock.mock.restore()
  })
  return {
    manager,
    target,
    processes,
    readyTimers,
    activeReadyTimers: () => readyTimers.filter((timer) => timer.active),
    start() {
      const started = manager.getOrStart(target, '/controlled/python')
      return { started, entry: manager.peek(target), proc: processes.at(-1) }
    },
    async startReady() {
      const result = this.start()
      result.proc.event({ type: 'ready' })
      await result.started
      return result
    },
  }
}

function reply(proc, command, ok = true) {
  proc.event({
    type: 'execute_reply',
    cell_id: command.cell_id,
    exec_id: command.exec_id,
    ok,
  })
}

for (const phase of ['during restart', 'idle after restart', 'during the next same-cell run']) {
  test(`a superseded execution's kernel_died is ignored ${phase}`, async (t) => {
    const h = harness(t)
    const { entry, proc } = await h.startReady()
    const oldRun = entry.run('same-cell', 'old work')
    const oldCommand = proc.commands.at(-1)
    const restarted = entry.restart()
    const restarting = observe(restarted)
    assert.equal((await oldRun).ok, false)
    let nextRun
    let nextCommand
    let nextState
    if (phase !== 'during restart') {
      proc.event({ type: 'ready' })
      await restarted
    }
    if (phase === 'during the next same-cell run') {
      nextRun = entry.run('same-cell', 'new work')
      nextState = observe(nextRun)
      nextCommand = proc.commands.at(-1)
      assert.notEqual(nextCommand.exec_id, oldCommand.exec_id)
    }
    proc.event({
      type: 'kernel_died',
      cell_id: oldCommand.cell_id,
      exec_id: oldCommand.exec_id,
      message: 'old kernel is no longer running',
    })
    await flush()
    assert.deepEqual(proc.kills, [], 'an obsolete execution must not kill the bridge')
    assert.equal(entry.proc, proc)
    if (phase === 'during restart') {
      assert.equal(restarting.status, 'pending')
      assert.equal(entry.ready, false)
      proc.event({ type: 'ready' })
      await restarted
    } else if (nextRun) {
      assert.equal(nextState.status, 'pending')
      assert.equal(entry.busy, true)
      reply(proc, nextCommand)
      assert.equal((await nextRun).ok, true)
    } else {
      assert.equal(entry.ready, true)
      assert.equal(entry.busy, false)
    }
  })
}

test('a scoped kernel death must match both the cell and execution IDs', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  const running = entry.run('current-cell', 'work')
  const state = observe(running)
  const command = proc.commands.at(-1)
  proc.event({ type: 'kernel_died', cell_id: 'other-cell', exec_id: command.exec_id, message: 'unrelated' })
  await flush()
  assert.deepEqual(proc.kills, [])
  assert.equal(state.status, 'pending')
  reply(proc, command)
  assert.equal((await running).ok, true)
})

for (const scope of ['current execution', 'unscoped']) {
  test(`a genuine ${scope} kernel death still fails the run and stops the bridge`, async (t) => {
    const h = harness(t)
    const { entry, proc } = await h.startReady()
    const running = entry.run('current-cell', 'work')
    const command = proc.commands.at(-1)
    const event = { type: 'kernel_died', message: 'kernel crashed' }
    if (scope === 'current execution') Object.assign(event, { cell_id: command.cell_id, exec_id: command.exec_id })
    proc.event(event)
    assert.equal((await running).ok, false)
    await flush()
    assert.ok(proc.kills.includes('SIGTERM'))
    assert.equal(entry.ready, false)
    assert.equal(h.manager.status(h.target).running, false)
  })
}

test('an unscoped kernel death also stops an idle bridge', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  proc.event({ type: 'kernel_died', message: 'idle kernel crashed' })
  await flush()
  assert.ok(proc.kills.includes('SIGTERM'))
  assert.equal(entry.ready, false)
  assert.equal(h.manager.status(h.target).running, false)
})

test('concurrent restarts during startup share one command and one ready timeout', async (t) => {
  const h = harness(t)
  const { started, entry, proc } = h.start()
  const first = observe(entry.restart())
  const second = observe(entry.restart())
  assert.equal(proc.commands.length, 0)
  assert.equal(h.activeReadyTimers().length, 1)
  proc.event({ type: 'ready' })
  // The first ready event is visible synchronously before restart resumes.
  // A caller in that gap must still wait for the already queued restart.
  const usable = observe(entry.ensureStarted())
  await started
  await flush()
  assert.equal(usable.status, 'pending')
  assert.equal(proc.commands.filter((command) => command.op === 'restart').length, 1)
  assert.equal(h.activeReadyTimers().length, 1, 'only the restart ready timeout may remain armed')
  assert.equal(first.status, 'pending')
  assert.equal(second.status, 'pending')
  proc.event({ type: 'ready' })
  await flush()
  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'fulfilled')
  assert.equal(usable.status, 'fulfilled')
  assert.equal(h.readyTimers.length, 2, 'one initial-start timeout and one restart timeout')
  assert.equal(h.activeReadyTimers().length, 0, 'no displaced timeout may later kill the ready bridge')
  assert.deepEqual(proc.kills, [])
  assert.equal(entry.ready, true)
})

test('an execution requested during startup and restart waits for the restarted kernel', async (t) => {
  const h = harness(t)
  const { started, entry, proc } = h.start()
  const restartState = observe(entry.restart())
  const running = entry.run('cell', 'work')
  const runState = observe(running)
  proc.event({ type: 'ready' })
  await started
  await flush()
  assert.equal(restartState.status, 'pending')
  assert.equal(runState.status, 'pending')
  assert.equal(proc.commands.some((command) => command.op === 'execute'), false)
  proc.event({ type: 'ready' })
  await flush()
  const commands = proc.commands.filter((command) => command.op === 'execute')
  assert.equal(commands.length, 1)
  reply(proc, commands[0])
  assert.equal((await running).ok, true)
  assert.equal(restartState.status, 'fulfilled')
})

test('shutdown during initial startup rejects waiting restarts without sending restart', async (t) => {
  const h = harness(t)
  const { started, entry, proc } = h.start()
  const startup = observe(started)
  const first = observe(entry.restart())
  const second = observe(entry.restart())
  await entry.shutdown()
  await flush()
  assert.equal(startup.status, 'rejected')
  assert.equal(first.status, 'rejected')
  assert.equal(second.status, 'rejected')
  assert.equal(proc.commands.some((command) => command.op === 'restart'), false)
  assert.equal(h.activeReadyTimers().length, 0)
})

test('failed startup rejects waiting restarts even while the failed process has not exited', async (t) => {
  const h = harness(t, { exitOnKill: false })
  const { started, entry, proc } = h.start()
  const startup = observe(started)
  const first = observe(entry.restart())
  const second = observe(entry.restart())
  proc.emit('error', new Error('controlled startup failure'))
  await flush()
  assert.equal(startup.status, 'rejected')
  assert.equal(first.status, 'rejected')
  assert.equal(second.status, 'rejected')
  assert.match(first.error.message, /controlled startup failure/)
  assert.match(second.error.message, /controlled startup failure/)
  assert.equal(proc.commands.some((command) => command.op === 'restart'), false)
  assert.equal(h.activeReadyTimers().length, 0)
})

test('shutdown during restart rejects all coalesced callers and clears its timeout', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  const first = observe(entry.restart())
  const second = observe(entry.restart())
  assert.equal(h.activeReadyTimers().length, 1)
  await entry.shutdown()
  await flush()
  assert.equal(first.status, 'rejected')
  assert.equal(second.status, 'rejected')
  assert.equal(proc.commands.filter((command) => command.op === 'restart').length, 1)
  assert.equal(h.activeReadyTimers().length, 0)
})

test('a restart ready timeout rejects every coalesced caller', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  const first = observe(entry.restart())
  const second = observe(entry.restart())
  const [timer] = h.activeReadyTimers()
  assert.ok(timer)
  timer.active = false
  timer.callback()
  await flush()
  assert.equal(first.status, 'rejected')
  assert.equal(second.status, 'rejected')
  assert.match(first.error.message, /did not restart within 30 seconds/)
  assert.match(second.error.message, /did not restart within 30 seconds/)
  assert.equal(proc.commands.filter((command) => command.op === 'restart').length, 1)
  assert.equal(h.activeReadyTimers().length, 0)
  assert.equal(h.manager.status(h.target).running, false)
})

test('an already-aborted execution request sends no kernel command', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  const controller = new AbortController()
  const reason = new Error('request already disconnected')
  controller.abort(reason)
  await assert.rejects(
    entry.run('cancelled', 'must not run', () => {}, { signal: controller.signal }),
    (error) => error === reason,
  )
  assert.equal(proc.commands.some((command) => command.op === 'execute'), false)
  assert.equal(entry.busy, false)
  assert.equal(entry.currentRun, null)
})

test('aborting a request waiting for restart prevents execution and leaves the kernel usable', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  const restarting = entry.restart()
  const controller = new AbortController()
  const reason = new Error('request disconnected while waiting')
  const cancelled = entry.run('cancelled', 'must not run', () => {}, { signal: controller.signal })
  // Attach rejection handling before releasing the readiness wait.
  const rejected = assert.rejects(cancelled, (error) => error === reason)
  controller.abort(reason)
  assert.equal(proc.commands.some((command) => command.op === 'execute'), false)
  proc.event({ type: 'ready' })
  await restarting
  await rejected
  assert.equal(proc.commands.some((command) => command.op === 'execute'), false)
  assert.equal(entry.busy, false)
  assert.equal(entry.currentRun, null)

  const live = entry.run('live', 'allowed work')
  const command = proc.commands.at(-1)
  assert.equal(command.op, 'execute')
  assert.equal(command.cell_id, 'live')
  reply(proc, command)
  assert.equal((await live).ok, true)
})

test('aborting an already-submitted request does not release the active execution slot', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  const controller = new AbortController()
  const running = entry.run('active', 'ongoing work', () => {}, { signal: controller.signal })
  const state = observe(running)
  const command = proc.commands.at(-1)
  controller.abort(new Error('client disconnected'))
  await flush()
  assert.equal(state.status, 'pending')
  assert.equal(entry.busy, true)
  assert.equal(entry.currentRun.execId, command.exec_id)
  await assert.rejects(entry.run('other', 'must wait'), (error) => error.code === 'kernel-busy')
  assert.equal(proc.commands.filter((item) => item.op === 'execute').length, 1)
  // The route owns interruption; only the kernel's terminal reply frees the slot.
  reply(proc, command, false)
  assert.equal((await running).ok, false)
  assert.equal(entry.busy, false)
  assert.equal(entry.currentRun, null)
})
