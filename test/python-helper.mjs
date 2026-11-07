import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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

// Windows only grants SeCreateSymbolicLinkPrivilege to elevated users or with
// Developer Mode enabled. Symlink-based regressions probe the capability
// instead of guessing from the platform/filesystem and then failing in setup.
export async function canCreateSymlinks() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bsb-ipynb-symlink-'))
  try {
    await writeFile(path.join(dir, 'target'), '')
    await symlink('target', path.join(dir, 'link'), 'file')
    return true
  } catch {
    return false
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
