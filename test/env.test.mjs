import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { discoverInterpreters, resetInterpreterCache, resolveInterpreter } from '../lib/env.js'

const execFileAsync = promisify(execFile)
const basePython = process.env.DSH_IPYNB_TEST_PYTHON || '/opt/miniconda3/bin/python3'
const hasJupyter = spawnSync(basePython, ['-c', 'import jupyter_client, ipykernel'], {
  stdio: 'ignore',
  timeout: 10_000,
}).status === 0

test('discovery preserves two venvs that share one base Python', { skip: !hasJupyter, timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-bsb-ipynb-venv-'))
  const environments = [path.join(root, 'venv-a'), path.join(root, 'venv-b')]
  const home = path.join(root, 'home')
  await mkdir(home)
  const variableNames = ['PATH', 'HOME', 'DSH_IPYNB_PYTHON', 'DSH_PRIMARY_RUNTIME', 'DSH_HOME']
  const originalEnvironment = Object.fromEntries(variableNames.map((name) => [name, process.env[name]]))
  try {
    const baseReal = await realpath(basePython)
    for (const environment of environments) {
      const result = spawnSync(basePython, ['-m', 'venv', '--system-site-packages', environment], {
        encoding: 'utf8',
        timeout: 30_000,
      })
      assert.equal(result.status, 0, result.stderr || String(result.error || 'venv creation failed'))
      assert.equal(await realpath(path.join(environment, 'bin', 'python3')), baseReal)
    }

    process.env.HOME = home
    process.env.PATH = environments.map((environment) => path.join(environment, 'bin')).join(path.delimiter)
    delete process.env.DSH_IPYNB_PYTHON
    delete process.env.DSH_PRIMARY_RUNTIME
    delete process.env.DSH_HOME
    resetInterpreterCache()

    const discovered = await discoverInterpreters({ fresh: true })
    for (const environment of environments) {
      const interpreterPath = path.join(environment, 'bin', 'python3')
      const entry = discovered.interpreters.find((candidate) => candidate.path === interpreterPath)
      assert.ok(entry, `missing independent interpreter entry for ${environment}`)
      assert.equal(entry.ok, true, entry.detail)
      const resolved = await resolveInterpreter(entry.path)
      assert.equal(resolved.path, interpreterPath)
      const { stdout } = await execFileAsync(resolved.path, [
        '-c',
        'import json, sys, jupyter_client, ipykernel; print(json.dumps({"prefix": sys.prefix, "executable": sys.executable}))',
      ])
      const actual = JSON.parse(stdout)
      assert.equal(await realpath(actual.prefix), await realpath(environment))
    }
  } finally {
    for (const name of variableNames) {
      const value = originalEnvironment[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    resetInterpreterCache()
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveInterpreter rejects malformed python arguments before probing', async () => {
  await assert.rejects(resolveInterpreter(123), (error) => error.code === 'bad-request' && error.status === 400)
  await assert.rejects(resolveInterpreter('   '), (error) => error.code === 'bad-request' && error.status === 400)
})
