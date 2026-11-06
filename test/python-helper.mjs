import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const candidates = [...new Set([
  process.env.DSH_IPYNB_TEST_PYTHON,
  '/opt/miniconda3/bin/python3',
  'python3',
  'python',
].filter(Boolean))]

export function findPython(imports = 'sys') {
  return candidates.find((candidate) =>
    spawnSync(candidate, ['-c', `import ${imports}`], {
      stdio: 'ignore',
      timeout: 10_000,
    }).status === 0)
}

export async function tempDir(t, prefix = 'dsh-bsb-ipynb-test-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
