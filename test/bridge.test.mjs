import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findPython, tempDir } from './python-helper.mjs'

const bridge = fileURLToPath(new URL('../python/bridge.py', import.meta.url))
const python = findPython('jupyter_client, ipykernel')

function startBridge(cwd) {
  const proc = spawn(python, ['-u', bridge, '--cwd', cwd], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  let buffer = ''
  const events = []
  const waiters = []
  proc.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      events.push(event)
      for (const waiter of [...waiters]) {
        if (waiter.match(event)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(event)
        }
      }
    }
  })
  const waitFor = (match, timeoutMs = 45_000) =>
    new Promise((resolve, reject) => {
      const existing = events.find(match)
      if (existing) {
        resolve(existing)
        return
      }
      const waiter = { match, resolve }
      waiters.push(waiter)
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index !== -1) waiters.splice(index, 1)
        reject(new Error(`Timed out waiting for bridge event; stderr: ${stderrTail.slice(-2000)}`))
      }, timeoutMs)
      waiter.resolve = (event) => {
        clearTimeout(timer)
        resolve(event)
      }
    })
  let stderrTail = ''
  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-8000)
  })
  return { proc, events, waitFor, stderr: () => stderrTail }
}

async function shutdown(proc) {
  proc.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

test('bridge executes code, preserves variables and reports errors', { skip: !python && 'Requires jupyter_client/ipykernel' }, async (t) => {
  const cwd = await tempDir(t, 'dsh-bsb-ipynb-bridge-')
  const context = startBridge(cwd)
  try {
    await context.waitFor((event) => event.type === 'ready')
    context.proc.stdin.write(
      JSON.stringify({ op: 'execute', cell_id: 'c1', code: 'x = 41\nprint("hello")\nx + 1' }) + '\n',
    )
    const reply = await context.waitFor((event) => event.type === 'execute_reply' && event.cell_id === 'c1')
    assert.equal(reply.ok, true)
    assert.equal(reply.execution_count, 1)
    const stream = context.events.find((event) => event.type === 'stream' && event.cell_id === 'c1')
    assert.equal(stream.text, 'hello\n')
    const result = context.events.find((event) => event.type === 'execute_result' && event.cell_id === 'c1')
    assert.equal(result.data['text/plain'], '42')

    context.proc.stdin.write(
      JSON.stringify({ op: 'execute', cell_id: 'c2', code: 'print(x)' }) + '\n',
    )
    await context.waitFor((event) => event.type === 'execute_reply' && event.cell_id === 'c2')
    const secondStream = context.events.find((event) => event.type === 'stream' && event.cell_id === 'c2')
    assert.equal(secondStream.text, '41\n')

    context.proc.stdin.write(
      JSON.stringify({ op: 'execute', cell_id: 'c3', code: '1 / 0' }) + '\n',
    )
    const errorReply = await context.waitFor((event) => event.type === 'execute_reply' && event.cell_id === 'c3')
    assert.equal(errorReply.ok, false)
    const errorEvent = context.events.find((event) => event.type === 'error' && event.cell_id === 'c3')
    assert.equal(errorEvent.ename, 'ZeroDivisionError')
    assert.ok(errorEvent.traceback.length > 0)

    context.proc.stdin.write(
      JSON.stringify({
        op: 'execute',
        cell_id: 'c4',
        code: 'from IPython.display import display\nhandle = display("one", display_id="d1")\nhandle.update("two")',
      }) + '\n',
    )
    const displayReply = await context.waitFor((event) => event.type === 'execute_reply' && event.cell_id === 'c4')
    assert.equal(displayReply.ok, true)
    const displays = context.events.filter(
      (event) =>
        (event.type === 'display_data' || event.type === 'update_display_data') && event.cell_id === 'c4',
    )
    const initial = displays.find((event) => event.type === 'display_data')
    assert.equal(initial.display_id, 'd1')
    assert.equal(initial.data['text/plain'], "'one'")
    const update = displays.find((event) => event.type === 'update_display_data')
    assert.equal(update.display_id, 'd1')
    assert.equal(update.data['text/plain'], "'two'")

    context.proc.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n')
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000)
      context.proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  } finally {
    await shutdown(context.proc)
  }
})

test('bridge rejects non-object JSON commands and continues executing', { skip: !python && 'Requires jupyter_client/ipykernel' }, async (t) => {
  const cwd = await tempDir(t, 'dsh-bsb-ipynb-bridge-invalid-')
  const context = startBridge(cwd)
  try {
    await context.waitFor((event) => event.type === 'ready')

    const invalidCommands = [null, [], 'status', 42, true]
    for (const command of invalidCommands) {
      context.proc.stdin.write(JSON.stringify(command) + '\n')
    }
    context.proc.stdin.write(
      JSON.stringify({ op: 'execute', cell_id: 'after-invalid', exec_id: 'exec-valid', code: '6 * 7' }) + '\n',
    )
    const reply = await context.waitFor(
      (event) => event.type === 'execute_reply' && event.cell_id === 'after-invalid',
    )
    assert.equal(reply.ok, true)
    assert.equal(reply.exec_id, 'exec-valid')
    const invalidLogs = context.events.filter(
      (event) =>
        event.type === 'log' && event.level === 'error' && event.message === 'invalid command: expected JSON object',
    )
    assert.equal(invalidLogs.length, invalidCommands.length)

    context.proc.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n')
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000)
      context.proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  } finally {
    await shutdown(context.proc)
  }
})

test('bridge marks interrupt-timeout restarts and clears old kernel state', { skip: !python && 'Requires jupyter_client/ipykernel' }, async (t) => {
  const cwd = await tempDir(t, 'dsh-bsb-ipynb-bridge-restart-')
  const context = startBridge(cwd)
  try {
    await context.waitFor((event) => event.type === 'ready')

    const code = [
      'import signal, time',
      'restart_marker = "old-kernel"',
      'signal.signal(signal.SIGINT, signal.SIG_IGN)',
      'print("sigint-ignored", flush=True)',
      'while True:',
      '    time.sleep(0.1)',
    ].join('\n')
    context.proc.stdin.write(
      JSON.stringify({ op: 'execute', cell_id: 'interrupt-timeout', exec_id: 'exec-timeout', code }) + '\n',
    )
    await context.waitFor(
      (event) =>
        event.type === 'stream' && event.cell_id === 'interrupt-timeout' && event.text.includes('sigint-ignored'),
    )
    context.proc.stdin.write(JSON.stringify({ op: 'interrupt' }) + '\n')
    const reply = await context.waitFor(
      (event) => event.type === 'execute_reply' && event.cell_id === 'interrupt-timeout',
    )
    assert.equal(reply.ok, false)
    assert.equal(reply.status, 'interrupted')
    assert.equal(reply.kernel_restarted, true)
    assert.match(reply.error, /interrupt timed out; kernel restarted/)

    context.proc.stdin.write(
      JSON.stringify({
        op: 'execute',
        cell_id: 'after-restart',
        exec_id: 'exec-after-restart',
        code: 'print("restart_marker" in globals())',
      }) + '\n',
    )
    const afterReply = await context.waitFor(
      (event) => event.type === 'execute_reply' && event.cell_id === 'after-restart',
    )
    assert.equal(afterReply.ok, true)
    const markerStream = context.events.find((event) => event.type === 'stream' && event.cell_id === 'after-restart')
    assert.equal(markerStream.text, 'False\n')

    context.proc.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n')
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000)
      context.proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  } finally {
    await shutdown(context.proc)
  }
})

test('bridge tags every execution event with its exec_id and fails input() fast', { skip: !python && 'Requires jupyter_client/ipykernel' }, async (t) => {
  const cwd = await tempDir(t, 'dsh-bsb-ipynb-bridge-exec-')
  const context = startBridge(cwd)
  try {
    await context.waitFor((event) => event.type === 'ready')

    context.proc.stdin.write(
      JSON.stringify({ op: 'execute', cell_id: 'e1', exec_id: 'exec-a', code: 'print("tagged")' }) + '\n',
    )
    const reply = await context.waitFor((event) => event.type === 'execute_reply' && event.cell_id === 'e1')
    assert.equal(reply.ok, true)
    assert.equal(reply.exec_id, 'exec-a')
    const touched = context.events.filter((event) => event.cell_id === 'e1')
    assert.ok(touched.length >= 2)
    for (const event of touched) assert.equal(event.exec_id, 'exec-a')

    // allow_stdin is disabled, so input() must fail immediately instead of
    // hanging the executor thread until an interrupt.
    context.proc.stdin.write(
      JSON.stringify({ op: 'execute', cell_id: 'in1', exec_id: 'exec-in', code: 'input("x")' }) + '\n',
    )
    const stdinReply = await context.waitFor(
      (event) => event.type === 'execute_reply' && event.cell_id === 'in1',
      20_000,
    )
    assert.equal(stdinReply.ok, false)
    assert.equal(stdinReply.exec_id, 'exec-in')
    const stdinError = context.events.find((event) => event.type === 'error' && event.cell_id === 'in1')
    assert.ok(stdinError)
    assert.match(stdinError.ename, /StdinNotImplementedError/)

    context.proc.stdin.write(
      JSON.stringify({ op: 'execute', cell_id: 'e2', exec_id: 'exec-b', code: '2 + 2' }) + '\n',
    )
    const third = await context.waitFor((event) => event.type === 'execute_reply' && event.cell_id === 'e2')
    assert.equal(third.ok, true)
    assert.equal(third.exec_id, 'exec-b')

    context.proc.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n')
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000)
      context.proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  } finally {
    await shutdown(context.proc)
  }
})
