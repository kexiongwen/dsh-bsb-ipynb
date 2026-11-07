import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promises as fsp } from 'node:fs'
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

// A restart only completes when the bridge echoes the operation id it was
// sent; tests must simulate that contract rather than rely on any ready event.
function restartReady(proc) {
  const command = proc.commands.filter((candidate) => candidate.op === 'restart').at(-1)
  assert.ok(command && Number.isInteger(command.id), 'a restart command with an operation id was sent')
  proc.event({ type: 'ready', op_id: command.id })
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
      restartReady(proc)
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
      restartReady(proc)
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
  restartReady(proc)
  await flush()
  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'fulfilled')
  assert.equal(usable.status, 'fulfilled')
  assert.equal(h.readyTimers.length, 2, 'one initial-start timeout and one restart timeout')
  assert.equal(h.activeReadyTimers().length, 0, 'no displaced timeout may later kill the ready bridge')
  assert.deepEqual(proc.kills, [])
  assert.equal(entry.ready, true)
})

test('a ready without the restart operation id cannot complete a restart wait', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  const restarting = observe(entry.restart())
  const command = proc.commands.at(-1)
  assert.equal(command.op, 'restart')
  assert.ok(Number.isInteger(command.id), 'restart carries an operation id')
  proc.event({ type: 'ready' })
  await flush()
  assert.equal(restarting.status, 'pending', 'a bridge-initiated ready must not satisfy a host restart')
  assert.equal(entry.ready, false)
  proc.event({ type: 'ready', op_id: command.id + 1 })
  await flush()
  assert.equal(restarting.status, 'pending', 'a different operation id must not satisfy the wait')
  restartReady(proc)
  await restarting
  assert.equal(entry.ready, true)
  assert.equal(h.activeReadyTimers().length, 0)
})

test('each restart command carries a fresh operation id', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  const first = entry.restart()
  await flush()
  const firstCommand = proc.commands.at(-1)
  restartReady(proc)
  await first
  const second = entry.restart()
  await flush()
  const secondCommand = proc.commands.at(-1)
  assert.equal(secondCommand.op, 'restart')
  assert.ok(Number.isInteger(firstCommand.id) && Number.isInteger(secondCommand.id))
  assert.notEqual(secondCommand.id, firstCommand.id, 'every restart needs its own operation id')
  restartReady(proc)
  await second
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
  restartReady(proc)
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

test('a disposed manager rejects new starts without spawning a process', async (t) => {
  const h = harness(t)
  await h.manager.disposeAll()
  await assert.rejects(
    h.manager.getOrStart(h.target, '/controlled/python'),
    (error) => error.code === 'kernel-unavailable' && /disposed/.test(error.message),
  )
  assert.equal(h.processes.length, 0)
  assert.equal(h.manager.kernelCount, 0)
})

test('dispose cleans up an initial start whose readiness has just completed', async (t) => {
  const h = harness(t)
  const { started, proc } = h.start()
  const startup = observe(started)
  proc.event({ type: 'ready' })
  // Dispose before the startEntry continuation can consume the resolved ready
  // wait. The late completion must be shut down, not returned to its caller.
  await h.manager.disposeAll()
  assert.equal(startup.status, 'rejected')
  assert.match(startup.error.message, /disposed/)
  assert.equal(proc.commands.some((command) => command.op === 'shutdown'), true)
  assert.equal(proc.exitCode, 0)
  assert.equal(h.manager.peek(h.target), null)
  assert.equal(h.processes.length, 1)
  assert.equal(h.activeReadyTimers().length, 0)
})

test('dispose during an interpreter switch prevents a late replacement spawn', async (t) => {
  const h = harness(t)
  const first = await h.startReady()
  // Hold the old process in its shutdown wait until both operations are in
  // flight, reproducing the await boundary in startEntry deterministically.
  first.proc.stdin.write = (line) => {
    first.proc.commands.push(JSON.parse(line))
    return true
  }
  const switching = observe(h.manager.getOrStart(h.target, '/controlled/other-python'))
  await flush()
  assert.equal(first.entry.stopping, true)
  const disposing = h.manager.disposeAll()
  await flush()
  assert.equal(h.processes.length, 1)
  first.proc.exit()
  await disposing
  assert.equal(switching.status, 'rejected')
  assert.match(switching.error.message, /disposed/)
  assert.equal(h.processes.length, 1, 'the interpreter switch must not resume after disposal')
  assert.equal(h.manager.peek(h.target), null)
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
  restartReady(proc)
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

// Keep the failed child alive long enough to deliver events after its
// replacement has been spawned. These are real manager/entry operations;
// only child-process scheduling is controlled by the harness.
async function replaceFailedProcess(t, failure = 'kernel-died') {
  const h = harness(t, { exitOnKill: false })
  let oldProc
  if (failure === 'startup-error') {
    const first = h.start()
    oldProc = first.proc
    const firstState = observe(first.started)
    oldProc.emit('error', new Error('first process failed during startup'))
    await flush()
    assert.equal(firstState.status, 'rejected')
  } else {
    const first = await h.startReady()
    oldProc = first.proc
    oldProc.event({ type: 'kernel_died', message: 'first kernel died' })
  }
  assert.equal(oldProc.exitCode, null, 'the old process has not exited yet')
  const replacement = h.start()
  const startup = observe(replacement.started)
  assert.notEqual(replacement.proc, oldProc, 'recovery must spawn a replacement process')
  return { h, oldProc, ...replacement, startup }
}

for (const failure of ['kernel-died', 'startup-error']) {
  for (const phase of ['starting', 'idle', 'executing']) {
    test(`old process exit after ${failure} cannot disturb a replacement that is ${phase}`, async (t) => {
      const { h, oldProc, entry, proc, started, startup } = await replaceFailedProcess(t, failure)
      let running
      let runState
      let command
      if (phase !== 'starting') {
        proc.event({ type: 'ready' })
        await started
      }
      if (phase === 'executing') {
        running = entry.run('replacement-cell', 'new work')
        runState = observe(running)
        command = proc.commands.at(-1)
      }
      const before = entry.status()
      oldProc.exit(7)
      await flush()
      assert.equal(entry.proc, proc, 'old exit must not discard the new process handle')
      assert.equal(h.manager.peek(h.target), entry, 'old exit must not forget the replacement entry')
      assert.deepEqual(entry.status(), before)
      assert.deepEqual(proc.kills, [], 'old exit must not kill the new process')
      if (phase === 'starting') {
        assert.equal(startup.status, 'pending', 'only the replacement may settle its readiness wait')
        assert.equal(h.activeReadyTimers().length, 1)
        proc.event({ type: 'ready' })
        await started
      } else if (phase === 'executing') {
        assert.equal(runState.status, 'pending', 'old exit must not settle the new execution')
        reply(proc, command)
        assert.equal((await running).ok, true)
      }
      // Filtering the old child must not disable lifecycle handling for the
      // current one: its own exit still removes the entry.
      proc.exit(9)
      await flush()
      assert.equal(entry.proc, null)
      assert.equal(h.manager.peek(h.target), null)
    })
  }
}

test('each process exit unlinks only its own connection file', async (t) => {
  const unlinked = []
  t.mock.method(fsp, 'unlink', async (file) => {
    unlinked.push(file)
  })
  const h = harness(t, { exitOnKill: false })
  const first = await h.startReady()
  const oldProc = first.proc
  const oldConnectionFile = first.entry.connectionFile
  oldProc.event({ type: 'kernel_died', message: 'first kernel died' })
  const replacement = h.start()
  const replacementConnectionFile = replacement.entry.connectionFile
  assert.notEqual(replacementConnectionFile, oldConnectionFile)
  replacement.proc.event({ type: 'ready' })
  await replacement.started

  oldProc.exit(7)
  await flush()
  assert.deepEqual(unlinked, [oldConnectionFile])
  assert.equal(replacement.entry.connectionFile, replacementConnectionFile)
  assert.equal(replacement.entry.proc, replacement.proc)

  replacement.proc.exit(9)
  await flush()
  assert.deepEqual(unlinked, [oldConnectionFile, replacementConnectionFile])
  assert.equal(replacement.entry.connectionFile, null)
})

const staleProcessEvents = {
  'stdin error': (proc) => proc.stdin.emit('error', new Error('stale EPIPE')),
  'process error': (proc) => proc.emit('error', new Error('stale process failure')),
  'ready output': (proc) => proc.event({ type: 'ready' }),
  'kernel death output': (proc) => proc.event({ type: 'kernel_died', message: 'stale kernel death' }),
  'untagged stream output': (proc) => proc.event({ type: 'stream', text: 'STALE OUTPUT', name: 'stdout' }),
  'partial stdout line': (proc) => proc.stdout.emit('data', '{"type":"stream","text":"STALE'),
  stderr: (proc) => proc.stderr.emit('data', 'STALE STDERR'),
}

for (const [name, emitStale] of Object.entries(staleProcessEvents)) {
  for (const phase of ['starting', 'executing']) {
    test(`old process ${name} cannot affect a replacement that is ${phase}`, async (t) => {
      const { h, oldProc, entry, proc, started, startup } = await replaceFailedProcess(t)
      const events = []
      let running
      let runState
      let command
      if (phase === 'executing') {
        proc.event({ type: 'ready' })
        await started
        running = entry.run('replacement-cell', 'new work', (event) => events.push(event))
        runState = observe(running)
        command = proc.commands.at(-1)
      }
      const before = entry.status()
      const stderrBefore = entry.stderrTail
      const stdoutBefore = entry.stdoutBuffer
      emitStale(oldProc)
      await flush()
      assert.equal(entry.proc, proc)
      assert.equal(h.manager.peek(h.target), entry)
      assert.deepEqual(entry.status(), before, 'stale child events must not change replacement status')
      assert.equal(entry.stderrTail, stderrBefore, 'old stderr must not pollute replacement diagnostics')
      assert.equal(entry.stdoutBuffer, stdoutBefore, 'old stdout must not pollute replacement framing')
      assert.deepEqual(proc.kills, [])
      assert.deepEqual(events, [], 'old events must not reach the replacement execution listener')
      if (phase === 'starting') {
        assert.equal(startup.status, 'pending')
        assert.equal(h.activeReadyTimers().length, 1)
        proc.event({ type: 'ready' })
        await started
        running = entry.run('replacement-cell', 'new work', (event) => events.push(event))
        runState = observe(running)
        command = proc.commands.at(-1)
      }
      assert.equal(runState.status, 'pending')
      proc.event({ type: 'stream', cell_id: command.cell_id, exec_id: command.exec_id, text: 'CURRENT OUTPUT' })
      assert.equal(events.at(-1).text, 'CURRENT OUTPUT', 'current child output must still be delivered')
      proc.exit(8)
      assert.equal((await running).ok, false, 'current child exit must still fail its active execution')
      assert.equal(h.manager.peek(h.target), null)
    })
  }
}

test('completion of an older shutdown cannot delete a replacement entry created during its exit', async (t) => {
  const h = harness(t)
  const first = await h.startReady()
  let replacement
  first.proc.once('exit', () => {
    // The old entry's exit handler has run, but its async shutdown has not
    // resumed yet. A new execute may create an entry in this interval.
    replacement = h.start()
    observe(replacement.started)
    replacement.proc.event({ type: 'ready' })
  })
  await h.manager.shutdown(h.target)
  assert.ok(replacement)
  await replacement.started
  assert.equal(h.manager.peek(h.target), replacement.entry, 'old shutdown must not delete the new map entry')
  assert.equal(replacement.entry.proc, replacement.proc)
  assert.equal(h.manager.status(h.target).ready, true)
  assert.deepEqual(replacement.proc.kills, [])
})

for (const phase of ['starting', 'executing']) {
  test(`a cleared old ready-timeout callback cannot fail a replacement that is ${phase}`, async (t) => {
    const { h, entry, proc, started, startup } = await replaceFailedProcess(t)
    const oldTimer = h.readyTimers[0]
    assert.equal(oldTimer.active, false, 'the superseded ready timer was cleared')
    let running
    let runState
    let command
    if (phase === 'executing') {
      proc.event({ type: 'ready' })
      await started
      running = entry.run('replacement-cell', 'new work')
      runState = observe(running)
      command = proc.commands.at(-1)
    }
    const before = entry.status()
    // Model a callback already dispatched by the timer machinery. It must
    // check its owner even if cancellation can no longer prevent invocation.
    oldTimer.callback()
    await flush()
    assert.equal(entry.proc, proc)
    assert.equal(h.manager.peek(h.target), entry)
    assert.deepEqual(entry.status(), before)
    assert.deepEqual(proc.kills, [])
    if (phase === 'starting') {
      assert.equal(startup.status, 'pending')
      assert.equal(h.activeReadyTimers().length, 1, 'the current ready timeout remains armed')
      proc.event({ type: 'ready' })
      await started
    } else {
      assert.equal(runState.status, 'pending')
      reply(proc, command)
      assert.equal((await running).ok, true)
    }
  })
}

test('an older idle sweep cannot delete a replacement entry created during shutdown', async (t) => {
  const h = harness(t)
  const first = await h.startReady()
  first.entry.lastActivity = 0
  let replacement
  first.proc.once('exit', () => {
    replacement = h.start()
    observe(replacement.started)
    replacement.proc.event({ type: 'ready' })
  })
  await h.manager.sweepIdle()
  assert.ok(replacement)
  await replacement.started
  assert.equal(h.manager.peek(h.target), replacement.entry, 'old sweep cleanup must not remove the new entry')
  assert.equal(replacement.entry.proc, replacement.proc)
  assert.equal(h.manager.status(h.target).ready, true)
  assert.deepEqual(replacement.proc.kills, [])
})

for (const origin of ['startup', 'previous restart']) {
  test(`a cleared ${origin} timer cannot settle a newer restart on the same process`, async (t) => {
    const h = harness(t, { exitOnKill: false })
    const { entry, proc } = await h.startReady()
    if (origin === 'previous restart') {
      const previousRestart = entry.restart()
      restartReady(proc)
      await previousRestart
    }
    const oldTimer = h.readyTimers.at(-1)
    assert.equal(oldTimer.active, false)
    const restarting = entry.restart()
    const state = observe(restarting)
    const currentTimer = h.readyTimers.at(-1)
    assert.notEqual(currentTimer, oldTimer)
    oldTimer.callback()
    await flush()
    assert.equal(state.status, 'pending', 'old wait callbacks cannot reject the newer readiness wait')
    assert.equal(entry.proc, proc)
    assert.equal(entry.ready, false)
    assert.equal(currentTimer.active, true)
    assert.deepEqual(proc.kills, [])
    restartReady(proc)
    await restarting
    assert.equal(entry.ready, true)
    assert.equal(h.activeReadyTimers().length, 0)
  })
}

test('a replacement process starts with fresh stderr diagnostics', async (t) => {
  const h = harness(t, { exitOnKill: false })
  const first = h.start()
  const startup = observe(first.started)
  first.proc.stderr.emit('data', 'FIRST PROCESS DIAGNOSTIC')
  first.proc.emit('error', new Error('first process failed'))
  await flush()
  assert.equal(startup.status, 'rejected')
  const replacement = h.start()
  observe(replacement.started)
  assert.equal(replacement.entry.stderrTail, '')
  replacement.proc.stderr.emit('data', 'CURRENT PROCESS DIAGNOSTIC')
  first.proc.stderr.emit('data', 'STALE PROCESS DIAGNOSTIC')
  assert.equal(replacement.entry.stderrTail, 'CURRENT PROCESS DIAGNOSTIC')
  replacement.proc.event({ type: 'ready' })
  await replacement.started
})

test('a failed spawn clears the entry instead of reporting a running kernel', async (t) => {
  const h = harness(t)
  const { started, entry, proc } = h.start()
  const state = observe(started)
  proc.emit('error', new Error('spawn ENOENT'))
  await flush()
  assert.equal(state.status, 'rejected')
  assert.match(state.error.message, /spawn ENOENT/)
  assert.equal(entry.proc, null)
  assert.equal(h.manager.peek(h.target), null)
  assert.equal(h.manager.status(h.target).running, false)
  assert.equal(h.manager.kernelCount, 0)
})

test('a successful restart clears stale status errors', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  entry.lastError = 'STALE FAILURE'
  const restarting = entry.restart()
  restartReady(proc)
  await restarting
  assert.equal(entry.lastError, null)
  assert.equal(h.manager.status(h.target).lastError, null)
})

test('a malformed frame during restart does not overwrite the framing error', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  const cause = 'Kernel output line exceeded 64 MiB; execution aborted and kernel restarted'
  entry.lastError = cause
  const restarting = entry.restart()
  entry.handleLine('TAIL-OF-GIANT-LINE-NOT-JSON')
  assert.equal(entry.lastError, cause)
  restartReady(proc)
  await restarting
  assert.equal(entry.lastError, null)
})

test('a ready-timeout cause survives the exit event that follows it', async (t) => {
  const h = harness(t, { exitOnKill: false })
  const { started, entry, proc } = h.start()
  const state = observe(started)
  const [timer] = h.activeReadyTimers()
  assert.ok(timer)
  timer.active = false
  timer.callback()
  await flush()
  assert.equal(state.status, 'rejected')
  proc.exit(1)
  await flush()
  assert.match(entry.lastError, /did not become ready within 30 seconds/)
})

test('shutdown clears its grace timer instead of keeping the event loop busy', async (t) => {
  const h = harness(t)
  await h.startReady()
  const activeTimeouts = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
  const before = activeTimeouts()
  await h.manager.shutdown(h.target)
  assert.ok(activeTimeouts() <= before, 'shutdown must clear the 2.5s grace timer')
})

test('the idle sweep skips entries that are already shutting down', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  entry.stopping = true
  entry.lastActivity = 0
  await h.manager.sweepIdle()
  assert.equal(h.manager.peek(h.target), entry)
  assert.equal(entry.proc, proc)
  assert.deepEqual(proc.kills, [])
  entry.stopping = false
})
