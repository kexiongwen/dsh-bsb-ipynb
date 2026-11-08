import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { realpath, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { KernelManager } from '../lib/kernel.js'
import { registerIpynbRoutes } from '../lib/routes.js'
import { tempDir } from './python-helper.mjs'

const flush = () => new Promise((resolve) => setImmediate(resolve))

function observe(promise) {
  const result = { status: 'pending' }
  promise.then(
    (value) => Object.assign(result, { status: 'fulfilled', value }),
    (error) => Object.assign(result, { status: 'rejected', error }),
  )
  return result
}

// Keep real entry/manager logic and control only the child and elapsed time.
// Every process is explicitly exited in cleanup, including assertion failures.
function harness(t, { exitOnShutdown = false, exitOnSignal = null, target = '/controlled/notebook.ipynb' } = {}) {
  const timers = new Set()
  const processes = []
  let now = 0
  const timeout = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = { at: now + delay, callback: () => callback(...args), unref() {} }
    timers.add(timer)
    return timer
  })
  const clear = t.mock.method(globalThis, 'clearTimeout', (timer) => { timers.delete(timer) })
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const proc = new EventEmitter()
    proc.pid = 1000 + processes.length
    proc.exitCode = null
    proc.signalCode = null
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdout.setEncoding = proc.stderr.setEncoding = () => {}
    proc.stdin = new EventEmitter()
    proc.stdin.destroyed = false
    proc.stdin.writableEnded = false
    proc.commands = []
    proc.kills = []
    let exited = false
    proc.exit = (code = 0, signal = null) => {
      if (exited) return
      exited = true
      proc.exitCode = code
      proc.signalCode = signal
      proc.stdin.destroyed = true
      proc.emit('exit', code, signal)
    }
    proc.stdin.write = (line) => {
      const command = JSON.parse(line)
      proc.commands.push(command)
      if (command.op === 'shutdown' && exitOnShutdown) proc.exit()
      return true
    }
    proc.stdin.end = () => { proc.stdin.writableEnded = true }
    proc.kill = (signal) => {
      proc.kills.push(signal)
      if (exitOnSignal === signal) proc.exit(null, signal)
      return true
    }
    proc.event = (event) => proc.stdout.emit('data', JSON.stringify(event) + '\n')
    processes.push(proc)
    return proc
  })
  syncBuiltinESMExports()
  const manager = new KernelManager({}, '/controlled/bridge.py')
  t.after(async () => {
    for (const proc of processes) proc.exit()
    await manager.disposeAll()
    spawn.mock.restore()
    syncBuiltinESMExports()
    timeout.mock.restore()
    clear.mock.restore()
  })
  return {
    manager, target, timers, processes,
    elapseWithoutCallbacks(milliseconds) { now += milliseconds },
    async advance(milliseconds) {
      const end = now + milliseconds
      for (;;) {
        const next = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        now = Math.max(now, next.at)
        timers.delete(next)
        next.callback()
        await flush()
      }
      now = end
      await flush()
    },
    async startReady() {
      const started = manager.getOrStart(target, '/controlled/python')
      await flush()
      const proc = processes.at(-1)
      proc.event({ type: 'ready' })
      return { entry: await started, proc }
    },
  }
}

test('shutdown waits through SIGTERM and SIGKILL until exit is confirmed', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  let reentrantShutdown
  const running = entry.run('active', 'work', (event) => {
    if (event.type === 'error') reentrantShutdown = entry.shutdown()
  })
  const shutdown = entry.shutdown()
  const state = observe(shutdown)
  assert.equal(reentrantShutdown, shutdown, 'the shared shutdown is published before run listeners are notified')
  assert.equal((await running).ok, false)
  assert.equal(entry.shutdown(), shutdown, 'concurrent shutdown callers share the same operation')
  assert.equal(proc.commands.filter((command) => command.op === 'shutdown').length, 1)
  assert.equal(entry.status().executionState, 'stopping')
  proc.event({ type: 'ready' })
  assert.equal(entry.ready, false, 'late ready cannot revive a stopping entry')
  await h.advance(1999)
  assert.deepEqual(proc.kills, [])
  await h.advance(501)
  assert.deepEqual(proc.kills, ['SIGTERM'])
  assert.equal(state.status, 'pending', 'the former 2.5 second timeout must not report success')
  assert.equal(h.manager.peek(h.target), entry)
  assert.equal(entry.proc, proc)
  await assert.rejects(entry.ensureStarted(), (error) => error.code === 'kernel-unavailable')
  await h.advance(1500)
  assert.deepEqual(proc.kills, ['SIGTERM', 'SIGKILL'])
  assert.equal(state.status, 'pending', 'sending SIGKILL alone is not exit confirmation')
  proc.exit(null, 'SIGKILL')
  await shutdown
  assert.equal(entry.proc, null)
  assert.equal(h.manager.peek(h.target), null)
  assert.equal(h.timers.size, 0)
  assert.equal(proc.listenerCount('exit'), 1, 'temporary shutdown listeners are removed')
  await h.advance(10000)
  assert.deepEqual(proc.kills, ['SIGTERM', 'SIGKILL'])
})

test('shutdown timeout retains a stopping entry, permits retry and cleans up on late exit', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  const state = observe(entry.shutdown())
  await h.advance(4500)
  assert.equal(state.status, 'rejected')
  assert.equal(state.error.code, 'kernel-unavailable')
  assert.deepEqual(state.error.details, { state: 'stopping' })
  assert.match(state.error.message, /did not exit/)
  assert.equal(entry.lastError, state.error.message)
  assert.equal(entry.stopping, true)
  assert.equal(entry.status().executionState, 'stopping')
  assert.equal(entry.proc, proc)
  assert.equal(h.manager.peek(h.target), entry, 'a live child must remain managed after timeout')
  assert.equal(h.timers.size, 0, 'a failed shutdown does not retain timers')
  assert.equal(proc.listenerCount('exit'), 1)
  await h.advance(10000)
  assert.deepEqual(proc.kills, ['SIGTERM', 'SIGKILL'])
  const retried = entry.shutdown()
  assert.equal(proc.commands.filter((command) => command.op === 'shutdown').length, 1, 'retry must not write to ended stdin')
  await h.advance(2000)
  assert.deepEqual(proc.kills, ['SIGTERM', 'SIGKILL', 'SIGTERM'])
  proc.exit(null, 'SIGTERM')
  await retried
  assert.equal(h.manager.peek(h.target), null)
  assert.equal(h.timers.size, 0)
})

test('shutdown route preserves stopping failures and status until actual exit, then allows retry', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'shutdown.ipynb')
  await writeFile(file, '{}')
  const target = await realpath(file)
  const h = harness(t, { target })
  const { entry, proc } = await h.startReady()
  let enteredShutdown
  const shutdown = h.manager.shutdown.bind(h.manager)
  t.mock.method(h.manager, 'shutdown', (...args) => {
    const result = shutdown(...args)
    enteredShutdown?.()
    return result
  })
  let handler
  registerIpynbRoutes({
    sessions: { get: (id) => id === 's1' ? { header: { cwd: dir } } : undefined },
    connection: { requestRejection: () => undefined },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }, h.manager)
  function request(method, url) {
    const chunks = []
    const state = { status: null, ended: false }
    const body = method === 'POST' ? { sessionId: 's1', path: 'shutdown.ipynb' } : undefined
    const req = {
      method, url, headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {
        if (body) yield Buffer.from(JSON.stringify(body))
      },
    }
    const res = {
      headersSent: false,
      writeHead(status) { state.status = status; this.headersSent = true },
      end(value) { if (value) chunks.push(Buffer.from(value)); state.ended = true },
    }
    return {
      state,
      promise: handler(req, res).then(() => JSON.parse(Buffer.concat(chunks).toString('utf8'))),
    }
  }
  let entered = new Promise((resolve) => { enteredShutdown = resolve })
  const closing = request('POST', '/ipynb/shutdown')
  // Admission/path validation runs asynchronously before entering the manager.
  assert.equal(await Promise.race([entered.then(() => true), closing.promise.then(() => false)]), true)
  assert.ok(proc.commands.some((command) => command.op === 'shutdown'))
  assert.equal(closing.state.ended, false)
  await h.advance(4500)
  const failure = await closing.promise
  assert.equal(closing.state.status, 503)
  assert.equal(failure.ok, false)
  assert.equal(failure.error.code, 'kernel-unavailable')
  assert.deepEqual(failure.error.details, { state: 'stopping' })
  assert.match(failure.error.message, /did not exit/)
  assert.equal(h.manager.peek(target), entry)
  assert.equal(entry.proc, proc)
  const status = await request('GET', '/ipynb/status?sessionId=s1&path=shutdown.ipynb').promise
  assert.equal(status.value.running, true)
  assert.equal(status.value.ready, false)
  assert.equal(status.value.executionState, 'stopping')
  assert.equal(status.value.lastError, failure.error.message)

  entered = new Promise((resolve) => { enteredShutdown = resolve })
  const retry = request('POST', '/ipynb/shutdown')
  // Wait for the route to retry the same retained entry, not a replacement.
  assert.equal(await Promise.race([entered.then(() => true), retry.promise.then(() => false)]), true)
  assert.ok(entry.shutdownPromise)
  proc.exit(null, 'SIGKILL')
  assert.equal((await retry.promise).ok, true)
  assert.equal(retry.state.status, 200)
  const stopped = await request('GET', '/ipynb/status?sessionId=s1&path=shutdown.ipynb').promise
  assert.equal(stopped.value.running, false)
  assert.equal(stopped.value.executionState, 'none')
  assert.equal((await request('POST', '/ipynb/shutdown').promise).ok, true, 'an absent kernel remains an idempotent success')
  assert.equal(h.processes.length, 1)
})

for (const exitMode of ['protocol', 'SIGTERM', 'SIGKILL']) {
  test(`shutdown cancels escalation timers after a synchronous ${exitMode} exit`, async (t) => {
    const h = harness(t, { exitOnShutdown: exitMode === 'protocol', exitOnSignal: exitMode })
    const { entry, proc } = await h.startReady()
    const shutdown = entry.shutdown()
    await h.advance(exitMode === 'protocol' ? 0 : exitMode === 'SIGTERM' ? 2000 : 4000)
    await shutdown
    const expected = exitMode === 'protocol' ? [] : exitMode === 'SIGTERM' ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL']
    assert.deepEqual(proc.kills, expected)
    assert.equal(entry.proc, null)
    assert.equal(h.timers.size, 0)
    assert.equal(proc.listenerCount('exit'), 1)
    await h.advance(10000)
    assert.deepEqual(proc.kills, expected, 'an exited process receives no delayed signals')
  })
}

test('repeated kill requests share escalation and stop sending signals after process exit', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  entry.kill(proc)
  entry.kill(proc)
  assert.deepEqual(proc.kills, ['SIGTERM'])
  proc.exit(null, 'SIGTERM')
  entry.kill(proc)
  await h.advance(10000)
  assert.deepEqual(proc.kills, ['SIGTERM'])
  assert.equal(h.timers.size, 0)
})

test('cleared shutdown callbacks cannot overwrite or signal a confirmed exit', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  const shutdown = entry.shutdown()
  const cancelledCallbacks = [...h.timers].map((timer) => timer.callback)
  proc.exit()
  await shutdown
  const stopped = entry.status()
  for (const callback of cancelledCallbacks) callback()
  assert.deepEqual(entry.status(), stopped)
  assert.deepEqual(proc.kills, [])
  assert.equal(h.timers.size, 0)
})

test('delayed timers still issue SIGKILL and allow an exit-confirmation window', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  const state = observe(entry.shutdown())
  h.elapseWithoutCallbacks(5000)
  await h.advance(0)
  assert.deepEqual(proc.kills, ['SIGTERM'])
  assert.equal(state.status, 'pending', 'a delayed protocol timer cannot skip forced termination')
  h.elapseWithoutCallbacks(5000)
  await h.advance(0)
  assert.deepEqual(proc.kills, ['SIGTERM', 'SIGKILL'])
  assert.equal(state.status, 'pending', 'confirmation starts after the actual SIGKILL')
  await h.advance(499)
  assert.equal(state.status, 'pending')
  proc.exit(null, 'SIGKILL')
  await flush()
  assert.equal(state.status, 'fulfilled')
  assert.equal(h.timers.size, 0)
})

test('shutdown remains bounded when an earlier kill escalation already sent SIGKILL', async (t) => {
  const h = harness(t)
  const { entry, proc } = await h.startReady()
  entry.kill(proc)
  await h.advance(2000)
  assert.deepEqual(proc.kills, ['SIGTERM', 'SIGKILL'])
  const state = observe(entry.shutdown())
  await h.advance(2499)
  assert.equal(state.status, 'pending')
  await h.advance(1)
  assert.equal(state.status, 'rejected')
  assert.equal(state.error.code, 'kernel-unavailable')
  assert.deepEqual(proc.kills, ['SIGTERM', 'SIGKILL'], 'a completed escalation is reused rather than restarting signals')
  assert.equal(entry.proc, proc)
  assert.equal(h.timers.size, 0)
})

for (const mode of ['shutdown', 'idle sweep', 'disposal']) {
  test(`${mode} retains a live stopping kernel after timeout and rejects a replacement`, async (t) => {
    const h = harness(t)
    const { entry, proc } = await h.startReady()
    let stopping
    if (mode === 'shutdown') stopping = h.manager.shutdown(h.target)
    else if (mode === 'disposal') stopping = h.manager.disposeAll()
    else {
      const previous = process.env.DSH_IPYNB_KERNEL_IDLE_MS
      process.env.DSH_IPYNB_KERNEL_IDLE_MS = '1'
      t.after(() => {
        if (previous === undefined) delete process.env.DSH_IPYNB_KERNEL_IDLE_MS
        else process.env.DSH_IPYNB_KERNEL_IDLE_MS = previous
      })
      entry.lastActivity = 0
      stopping = h.manager.sweepIdle()
    }
    const state = observe(stopping)
    await h.advance(2500)
    assert.equal(state.status, 'pending')
    assert.equal(h.manager.peek(h.target), entry)
    assert.equal(h.manager.status(h.target).running, true)
    await h.advance(2000)
    assert.equal(state.status, 'rejected')
    assert.equal(state.error.code, 'kernel-unavailable')
    assert.equal(h.manager.peek(h.target), entry)
    assert.equal(h.manager.status(h.target).executionState, 'stopping')
    await assert.rejects(h.manager.getOrStart(h.target, entry.python), (error) => error.code === 'kernel-unavailable')
    assert.equal(h.processes.length, 1, 'timeout must not permit another bridge to spawn')
    proc.exit(null, 'SIGKILL')
    await flush()
    assert.equal(h.manager.peek(h.target), null, 'the eventual exit releases the retained entry')
    assert.equal(h.timers.size, 0)
  })
}
