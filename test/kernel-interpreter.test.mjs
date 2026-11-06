import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { KernelManager } from '../lib/kernel.js'

const execFileAsync = promisify(execFile)
const basePython = process.env.DSH_IPYNB_TEST_PYTHON || '/opt/miniconda3/bin/python3'
const hasJupyter = spawnSync(basePython, ['-c', 'import jupyter_client, ipykernel'], {
  stdio: 'ignore',
  timeout: 10_000,
}).status === 0
const bridgePath = fileURLToPath(new URL('../python/bridge.py', import.meta.url))
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

function assertSelectedEnvironment(actual, environment, phase) {
  // Do not compare only realpath(executable): a venv's Python commonly points
  // to the same base binary, which would let the original bug pass this test.
  assert.equal(path.resolve(actual.executable), path.resolve(environment.python), `${phase}: kernel executable must retain the selected invocation path`)
  assert.equal(path.resolve(actual.prefix), path.resolve(environment.root), `${phase}: kernel prefix must be the selected venv`)
  assert.equal(actual.module_value, environment.name, `${phase}: environment-only package must be importable`)
  assert.equal(path.resolve(actual.module_file), path.resolve(environment.moduleFile), `${phase}: package must come from the selected venv`)
  assert.equal(actual.spec_environment_marker, null, `${phase}: unrelated kernelspec environment must not be inherited`)
}

test('selected Python controls real kernels despite a conflicting kernelspec, across restart and environment switches', {
  skip: !hasJupyter && 'Requires jupyter_client/ipykernel in DSH_IPYNB_TEST_PYTHON',
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
