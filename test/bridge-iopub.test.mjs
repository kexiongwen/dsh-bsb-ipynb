import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const runFile = promisify(execFile)
const fixture = fileURLToPath(new URL('./bridge_iopub.py', import.meta.url))
const bridge = fileURLToPath(new URL('../python/bridge.py', import.meta.url))
const candidates = [...new Set([
  process.env.DSH_IPYNB_TEST_PYTHON,
  '/opt/miniconda3/bin/python3',
  'python3',
  'python',
].filter(Boolean))]

function supports(executable, imports) {
  return spawnSync(executable, ['-c', imports], { stdio: 'ignore', timeout: 10_000 }).status === 0
}

const python = candidates.find((candidate) => supports(candidate, 'import sys'))
const kernelPython = candidates.find((candidate) => supports(candidate, 'import jupyter_client, ipykernel'))

async function runFixture(executable, ...args) {
  try {
    return await runFile(executable, ['-B', fixture, '--bridge', bridge, ...args], {
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
  } catch (error) {
    assert.fail(`IOPub regression fixture failed: ${error.message}\n${error.stdout || ''}\n${error.stderr || ''}`)
  }
}

test('bridge IOPub routing bounds retained messages and preserves registration/output ordering', {
  skip: !python && 'Requires Python',
}, async () => {
  const result = await runFixture(python)
  assert.match(result.stderr, /OK\s*$/)
})

test('a real kernel drops 1000 background messages from a completed cell without retaining or misattributing them', {
  skip: !kernelPython && 'Requires jupyter_client/ipykernel',
}, async () => {
  const result = await runFixture(kernelPython, '--integration')
  const value = JSON.parse(result.stdout.trim())
  assert.equal(value.received, 1000)
  assert.equal(value.retained, 0)
  assert.equal(value.forwarded, 0)
  assert.equal(value.currentOutput, 'CURRENT RESULT\n')
})
