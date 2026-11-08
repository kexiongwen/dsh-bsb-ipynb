import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

test('package manifest ships the examples directory and declares the documented DSH minimum', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.files.includes('examples'), 'examples must survive npm pack')
  assert.equal(manifest.engines.dsh, '>=0.2.2-rc.1')
})
