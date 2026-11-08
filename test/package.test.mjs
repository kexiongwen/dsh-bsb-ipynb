import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('package manifest ships the examples directory and declares the documented DSH minimum', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.files.includes('examples'), 'examples must survive npm pack')
  assert.equal(manifest.engines.dsh, '>=0.2.2-rc.1')
})

test('npm pack includes the linked documentation and screenshot', async (t) => {
  const cache = await mkdtemp(path.join(os.tmpdir(), 'dsh-bsb-ipynb-pack-'))
  t.after(async () => { await rm(cache, { recursive: true, force: true }) })
  const options = {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache },
    maxBuffer: 4 * 1024 * 1024,
  }
  // Windows resolves npm through a .cmd shim. Use one fixed shell command
  // there (no untrusted arguments); POSIX can spawn npm directly.
  const result = process.platform === 'win32'
    ? spawnSync('npm pack --dry-run --json', { ...options, shell: true })
    : spawnSync('npm', ['pack', '--dry-run', '--json'], options)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const [packed] = JSON.parse(result.stdout)
  const files = new Set(packed.files.map((entry) => entry.path))
  for (const required of [
    'README.md',
    'README_ZH.md',
    'docs/screenshot.png',
    'client.js',
    'python/bridge.py',
    'icon.svg',
    'locale/zh.json',
  ]) {
    assert.ok(files.has(required), `${required} must be present in the packed bundle`)
  }
})
