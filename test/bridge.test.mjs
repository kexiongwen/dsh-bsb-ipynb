import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const bridge = fileURLToPath(new URL('../python/bridge.py', import.meta.url))
const python = process.env.DSH_IPYNB_TEST_PYTHON || '/opt/miniconda3/bin/python3'

function hasJupyter(executable) {
  const result = spawnSync(executable, ['-c', 'import jupyter_client, ipykernel'], { timeout: 10_000 })
  return result.status === 0
}

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

test('bridge executes code, preserves variables and reports errors', { skip: !hasJupyter(python) }, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-bsb-ipynb-bridge-'))
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
