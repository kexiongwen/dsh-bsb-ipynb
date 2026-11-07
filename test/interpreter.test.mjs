import assert from 'node:assert/strict'
import { test } from 'node:test'
import childProcess, { execFile, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { KernelManager } from '../lib/kernel.js'
import { findPython, tempDir } from './python-helper.mjs'

const execFileAsync = promisify(execFile)
let probeOverride = null
const originalExecFile = childProcess.execFile
const mockExecFile = () => { throw new Error('Unexpected callback-style interpreter probe') }
mockExecFile[promisify.custom] = async (...args) => {
  if (probeOverride) return probeOverride(...args)
  return execFileAsync(...args)
}
let discoverInterpreters
let resetInterpreterCache
let resolveInterpreter
try {
  childProcess.execFile = mockExecFile
  syncBuiltinESMExports()
  ;({ discoverInterpreters, resetInterpreterCache, resolveInterpreter } = await import('../lib/env.js'))
} finally {
  childProcess.execFile = originalExecFile
  syncBuiltinESMExports()
}

const basePython = findPython('jupyter_client, ipykernel')
const hasJupyter = Boolean(basePython)
const bridgePath = fileURLToPath(new URL('../python/bridge.py', import.meta.url))

test('discovery preserves two venvs that share one base Python', {
  skip: !hasJupyter && 'Requires jupyter_client/ipykernel',
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-bsb-ipynb-venv-'))
  const environments = [path.join(root, 'venv-a'), path.join(root, 'venv-b')]
  const home = path.join(root, 'home')
  await mkdir(home)
  const variableNames = ['PATH', 'HOME', 'USERPROFILE', 'DSH_IPYNB_PYTHON', 'DSH_PRIMARY_RUNTIME', 'DSH_HOME']
  const originalEnvironment = Object.fromEntries(variableNames.map((name) => [name, process.env[name]]))
  try {
    const baseReal = await realpath(basePython)
    // A Windows venv keeps its interpreter under Scripts/ and copies the base
    // executable instead of symlinking it; POSIX venvs keep bin/python3.
    const venvBin = process.platform === 'win32' ? 'Scripts' : 'bin'
    const venvInterpreter = process.platform === 'win32' ? 'python.exe' : 'python3'
    for (const environment of environments) {
      const result = spawnSync(basePython, ['-m', 'venv', '--system-site-packages', environment], {
        encoding: 'utf8',
        timeout: 30_000,
      })
      assert.equal(result.status, 0, result.stderr || String(result.error || 'venv creation failed'))
      const interpreter = path.join(environment, venvBin, venvInterpreter)
      if (process.platform === 'win32') {
        // The copied interpreter is a different file, so realpath identity does
        // not apply; the sys.prefix assertion after discovery proves it.
        assert.ok((await stat(interpreter)).isFile(), `missing venv interpreter ${interpreter}`)
      } else {
        assert.equal(await realpath(interpreter), baseReal)
      }
    }

    process.env.HOME = home
    // os.homedir() uses USERPROFILE on Windows; pin it too so a developer's
    // real ~/.conda/environments.txt cannot leak into the discovery result.
    if (process.platform === 'win32') process.env.USERPROFILE = home
    process.env.PATH = environments.map((environment) => path.join(environment, venvBin)).join(path.delimiter)
    delete process.env.DSH_IPYNB_PYTHON
    delete process.env.DSH_PRIMARY_RUNTIME
    delete process.env.DSH_HOME
    resetInterpreterCache()

    const discovered = await discoverInterpreters({ fresh: true })
    for (const environment of environments) {
      const interpreterPath = path.join(environment, venvBin, venvInterpreter)
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
  await assert.rejects(resolveInterpreter('python'), (error) =>
    error.code === 'bad-request' && error.status === 400 && /absolute/.test(error.message))
})

test('discovery rejects a failed probe even when stdout reports ok:true', async () => {
  const previous = process.env.DSH_IPYNB_PYTHON
  const failure = Object.assign(new Error('Python probe exited with code 1'), {
    code: 1,
    stdout: JSON.stringify({
      ok: true,
      executable: process.execPath,
      version: '3.14',
      jupyter_client: 'test',
      ipykernel: 'test',
    }),
    stderr: 'probe failed after writing stdout',
  })
  try {
    process.env.DSH_IPYNB_PYTHON = process.execPath
    probeOverride = async () => { throw failure }
    resetInterpreterCache()
    const discovered = await discoverInterpreters({ fresh: true })
    const entry = discovered.interpreters.find((candidate) => candidate.source === 'DSH_IPYNB_PYTHON')
    assert.ok(entry, 'the rejected interpreter stays visible')
    assert.equal(entry.ok, false)
    assert.equal(discovered.default, null)
    assert.equal(entry.version, '3.14', 'stdout remains available for diagnostics')
    assert.match(entry.detail, /code 1/)
  } finally {
    probeOverride = null
    if (previous === undefined) delete process.env.DSH_IPYNB_PYTHON
    else process.env.DSH_IPYNB_PYTHON = previous
    resetInterpreterCache()
  }
})

test('discovery keeps a relative DSH_IPYNB_PYTHON visible with a clear reason', async () => {
  const previous = process.env.DSH_IPYNB_PYTHON
  try {
    process.env.DSH_IPYNB_PYTHON = 'python'
    resetInterpreterCache()
    const discovered = await discoverInterpreters({ fresh: true })
    const entry = discovered.interpreters.find((candidate) => candidate.source === 'DSH_IPYNB_PYTHON')
    assert.ok(entry, 'a misconfigured DSH_IPYNB_PYTHON stays visible')
    assert.equal(entry.ok, false)
    assert.match(entry.detail, /absolute path/)
  } finally {
    if (previous === undefined) delete process.env.DSH_IPYNB_PYTHON
    else process.env.DSH_IPYNB_PYTHON = previous
    resetInterpreterCache()
  }
})

test('an empty platform discovery reports an actionable kernel-unavailable error', async (t) => {
  const home = await tempDir(t, 'dsh-empty-home-')
  const names = ['PATH', 'HOME', 'USERPROFILE', 'DSH_IPYNB_PYTHON', 'DSH_PRIMARY_RUNTIME', 'DSH_HOME']
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  try {
    process.env.PATH = ''
    process.env.HOME = home
    if (process.platform === 'win32') process.env.USERPROFILE = home
    delete process.env.DSH_IPYNB_PYTHON
    delete process.env.DSH_PRIMARY_RUNTIME
    delete process.env.DSH_HOME
    resetInterpreterCache()
    await assert.rejects(resolveInterpreter(), (error) =>
      error.code === 'kernel-unavailable' &&
      /No Python interpreter candidates/.test(error.message) &&
      /DSH_IPYNB_PYTHON/.test(error.message))
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    resetInterpreterCache()
  }
})

const moduleName = 'dsh_ipynb_selected_env_probe'
const specEnvironmentMarker = `DSH_IPYNB_TEST_KERNELSPEC_${process.pid}`
const outputPrefix = 'DSH_SELECTED_ENV_JSON:'
const inspectCode = [
  'import importlib.util, json, os, sys',
  `spec = importlib.util.find_spec(${JSON.stringify(moduleName)})`,
  `probe = __import__(${JSON.stringify(moduleName)}) if spec is not None else None`,
  `print(${JSON.stringify(outputPrefix)} + json.dumps({`,
  '    "executable": sys.executable, "prefix": sys.prefix,',
  '    "module_value": getattr(probe, "VALUE", None),',
  '    "module_file": getattr(probe, "__file__", None),',
  `    "spec_environment_marker": os.environ.get(${JSON.stringify(specEnvironmentMarker)}),`,
  '}))',
].join('\n')

async function within(promise, label) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} did not complete`)), 35_000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function readInspection(stdout) {
  const line = stdout.split(/\r?\n/).find((value) => value.startsWith(outputPrefix))
  assert.ok(line, `Missing interpreter inspection output: ${stdout}`)
  return JSON.parse(line.slice(outputPrefix.length))
}

function normalizeInvocationPath(value) {
  const resolved = path.resolve(value)
  return path.join(realpathSync(path.dirname(resolved)), path.basename(resolved))
}

function assertSelectedEnvironment(actual, environment, phase) {
  // Do not compare realpath(executable) directly: a venv's Python commonly
  // points to the same base binary, which would let the original bug pass.
  // Normalize only the directory so macOS /var -> /private/var aliases compare
  // equal while the selected venv's bin path is still required.
  assert.equal(normalizeInvocationPath(actual.executable), normalizeInvocationPath(environment.python), `${phase}: kernel executable must retain the selected invocation path`)
  assert.equal(realpathSync(actual.prefix), realpathSync(environment.root), `${phase}: kernel prefix must be the selected venv`)
  assert.equal(actual.module_value, environment.name, `${phase}: environment-only package must be importable`)
  assert.equal(realpathSync(actual.module_file), realpathSync(environment.moduleFile), `${phase}: package must come from the selected venv`)
  assert.equal(actual.spec_environment_marker, null, `${phase}: unrelated kernelspec environment must not be inherited`)
}

test('selected Python controls real kernels despite a conflicting kernelspec, across restart and environment switches', {
  skip: !hasJupyter && 'Requires jupyter_client/ipykernel',
  timeout: 150_000,
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-kernel-interpreter-'))
  const priorJupyterPath = process.env.JUPYTER_PATH
  let manager
  try {
    assert.equal(process.env[specEnvironmentMarker], undefined, 'the marker must originate only in the conflicting kernelspec')
    const { stdout } = await execFileAsync(basePython, ['-c', 'import sys; print(sys.executable)'], { timeout: 10_000 })
    const baseExecutable = stdout.trim()
    assert.ok(path.isAbsolute(baseExecutable))
    const environments = []
    for (const name of ['venv-a', 'venv-b']) {
      const root = path.join(temporary, name)
      await execFileAsync(basePython, ['-m', 'venv', '--system-site-packages', '--without-pip', root], { timeout: 30_000 })
      const python = process.platform === 'win32'
        ? path.join(root, 'Scripts', 'python.exe')
        : path.join(root, 'bin', 'python3')
      const { stdout: purelib } = await execFileAsync(python, ['-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'], { timeout: 10_000 })
      const moduleFile = path.join(purelib.trim(), `${moduleName}.py`)
      await writeFile(moduleFile, `VALUE = ${JSON.stringify(name)}\n`)
      const environment = { name, root, python, moduleFile }
      const direct = await execFileAsync(python, ['-c', inspectCode], { timeout: 10_000 })
      assertSelectedEnvironment(readInspection(direct.stdout), environment, `${name} direct invocation`)
      environments.push(environment)
    }

    const jupyterPath = path.join(temporary, 'jupyter')
    const kernelspecDirectory = path.join(jupyterPath, 'kernels', 'python3')
    await mkdir(kernelspecDirectory, { recursive: true })
    const kernelspecFile = path.join(kernelspecDirectory, 'kernel.json')
    const originalKernelspec = JSON.stringify({
      argv: [baseExecutable, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
      display_name: 'Conflicting base Python',
      language: 'python',
      env: { [specEnvironmentMarker]: 'from-conflicting-kernelspec' },
    }, null, 2)
    await writeFile(kernelspecFile, originalKernelspec)
    // This setting is inherited only by this test's bridge processes. No user
    // kernelspec is installed, replaced or removed.
    process.env.JUPYTER_PATH = jupyterPath

    const target = path.join(temporary, 'same-notebook.ipynb')
    await writeFile(target, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }))
    manager = new KernelManager({}, bridgePath)
    let previousEntry
    for (const environment of environments) {
      const entry = await within(manager.getOrStart(target, environment.python), `${environment.name} startup`)
      assert.equal(entry.python, environment.python)
      assert.equal(manager.kernelCount, 1)
      if (previousEntry) assert.notEqual(entry, previousEntry, 'switching environments must replace the bridge')
      for (const phase of ['initial', 'after restart']) {
        if (phase === 'after restart') await within(manager.restart(target), `${environment.name} restart`)
        let output = ''
        const errors = []
        const reply = await within(entry.run('inspect-environment', inspectCode, (event) => {
          if (event.type === 'stream') output += event.text
          if (event.type === 'error' || event.type === 'fatal') errors.push(event)
        }), `${environment.name} ${phase} execution`)
        assert.equal(reply.ok, true, JSON.stringify({ reply, errors }))
        assertSelectedEnvironment(readInspection(output), environment, `${environment.name} ${phase}`)
        assert.equal(await readFile(kernelspecFile, 'utf8'), originalKernelspec, 'the conflicting user kernelspec must remain unchanged')
      }
      previousEntry = entry
    }
  } finally {
    try {
      await manager?.disposeAll()
    } finally {
      if (priorJupyterPath === undefined) delete process.env.JUPYTER_PATH
      else process.env.JUPYTER_PATH = priorJupyterPath
      await rm(temporary, { recursive: true, force: true })
    }
  }
})
