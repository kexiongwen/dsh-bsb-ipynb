// End-to-end smoke test for the pinned DSH + dsh-better-sidebar pair.
//
// The test creates an isolated DSH_HOME, installs this repository and
// dsh-better-sidebar@0.32.1 into a fresh Web profile, boots `dsh` on a free
// port, opens a temporary notebook through the real Better Sidebar file tree,
// runs one cell with the real Python kernel and checks the autosaved output.
//
// Requirements:
//   - Node 20+ and the `playwright` dev dependency (`npm install`);
//   - Google Chrome (the test uses Playwright's `channel: "chrome"`);
//   - a DSH CLI. Set DSH_E2E_DSH_BIN, or run inside DSH Desktop where
//     DSH_INSTALL_DIR / DSH_NODE_EXECUTABLE are present.
//
// The exact versions are pinned below. When either dependency is upgraded,
// update the constants and re-run `npm run test:e2e`.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PINNED_DSH = '0.2.2-rc.3'
const PINNED_BSB = '0.32.1'
const PROFILE = 'dsh-bsb-ipynb-e2e'
const TIMEOUT_MS = 60_000

function log(message) {
  process.stdout.write(`[e2e] ${message}\n`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveDsh() {
  if (process.env.DSH_E2E_DSH_BIN) {
    return {
      command: path.resolve(ROOT, process.env.DSH_E2E_DSH_BIN),
      prefix: [],
      env: {},
    }
  }
  if (process.env.DSH_INSTALL_DIR && process.env.DSH_NODE_EXECUTABLE) {
    return {
      command: process.env.DSH_NODE_EXECUTABLE,
      prefix: [path.join(process.env.DSH_INSTALL_DIR, 'lib', 'bin.js')],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe'] : ['dsh']
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(directory, name)
      if (existsSync(candidate)) return { command: candidate, prefix: [], env: {} }
    }
  }
  throw new Error(
    'No DSH CLI found. Set DSH_E2E_DSH_BIN to the dsh executable, or run inside DSH Desktop ' +
    '(DSH_INSTALL_DIR / DSH_NODE_EXECUTABLE).',
  )
}

const cli = resolveDsh()

function runDsh(args, { env = {}, timeout = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli.command, [...cli.prefix, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...cli.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`dsh ${args.join(' ')} timed out after ${timeout} ms\n${stderr.slice(-4000)}`))
    }, timeout)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`dsh ${args.join(' ')} exited with ${code}\n${stderr.slice(-4000)}`))
    })
  })
}

async function waitForServerUrl(child, timeout = 90_000) {
  let output = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`dsh web did not print a URL within ${timeout} ms\n${output.slice(-4000)}`))
    }, timeout)
    const onData = (chunk) => {
      output += chunk
      const match = output.match(/dsh web:\s+(http:\/\/\S+)/)
      if (!match) return
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited with ${code} before printing a URL\n${output.slice(-4000)}`))
    })
  })
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return
  const signal = (name) => {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        process.kill(-child.pid, name)
      }
    } catch {
      try { child.kill(name) } catch { /* already gone */ }
    }
  }
  signal('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(5_000),
  ])
  if (child.exitCode === null) signal('SIGKILL')
}

function notebookFor(marker) {
  return {
    cells: [{
      cell_type: 'code',
      execution_count: null,
      id: 'e2e-cell',
      metadata: {},
      outputs: [],
      source: [`print(${JSON.stringify(marker)})`],
    }],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }
}

async function launchBrowser() {
  let playwright
  try {
    playwright = await import('playwright')
  } catch (error) {
    throw new Error(`playwright is not installed; run "npm install" (${error.message})`)
  }
  try {
    return await playwright.chromium.launch({ channel: 'chrome', headless: true })
  } catch (channelError) {
    log('Chrome channel unavailable, trying Playwright Chromium: ' + channelError.message.split('\n')[0])
    return await playwright.chromium.launch({ headless: true })
  }
}

async function dismissPreview(page) {
  // A fresh DSH_HOME shows the Preview Notice and/or the account "Get started"
  // dialog. Dismiss whichever appears; the account row is seeded by the profile
  // patch where possible, and Escape is the fallback for an unexpected dialog.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = page.getByRole('button', { name: /^(继续|Continue)$/ })
    if (await next.count()) {
      await next.first().click()
      await page.waitForTimeout(600)
      continue
    }
    const close = page.getByRole('button', { name: /^(关闭|Close)$/ })
    if (await close.count()) {
      await close.first().click()
      await page.waitForTimeout(600)
      continue
    }
    const dialog = page.locator('[role="dialog"], [role="presentation"] [aria-hidden="true"]._mask_1ytzq_18')
    if (await dialog.count()) {
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(600)
      continue
    }
    break
  }
}

async function openRightSidebar(page) {
  const open = page.getByRole('button', { name: /打开右侧边栏|Open right sidebar/i })
  if (await open.count()) {
    await open.first().click()
    await page.waitForTimeout(500)
  }
}

async function openFilesPage(page) {
  const files = page.getByRole('button', { name: /^(文件|Files)\b/i })
  if (await files.count()) {
    await files.first().click()
  } else {
    const tab = page.getByText(/^(文件|Files)$/i, { exact: true })
    await tab.first().click()
  }
  await page.waitForTimeout(800)
}

async function assertSettingsPanel(page) {
  // A fresh profile's account launcher is the documented route to Settings;
  // the pinned English locale makes these labels stable.
  await page.getByRole('button', { name: /Account menu|账号菜单/i }).first().click()
  await page.getByRole('menuitem', { name: /^Settings/ }).click()
  const sideCard = page.getByRole('button', { name: /^(Side card|侧边卡片)$/ })
  await sideCard.waitFor({ state: 'visible', timeout: 20_000 })
  await sideCard.click()

  const gear = page.getByRole('button', { name: /^Jupyter Notebook.*(Feature settings|设置)$/ })
  await gear.waitFor({ state: 'visible', timeout: 20_000 })
  await gear.click()

  const panel = page.locator('.dsh-bsb-ipynb-settings')
  await panel.waitFor({ state: 'visible', timeout: 20_000 })
  for (const label of ['Autosave delay', 'Default interpreter', 'Kernel idle timeout']) {
    assert.equal(await panel.getByText(label, { exact: true }).count(), 1, `settings panel renders "${label}"`)
  }
  // The interpreter list comes from /ipynb/interpreters; wait for at least
  // the server-default option plus one discovered environment.
  await panel.locator('select option').nth(1).waitFor({ state: 'attached', timeout: 20_000 })
  assert.ok(await panel.locator('select option').count() >= 2, 'settings panel lists discovered interpreters')

  // Reloading is the simplest way back to the composer without depending on
  // the Settings popup's close affordance; the page re-boots the plugin.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })
  await page.waitForTimeout(1_500)
  await dismissPreview(page)
}

async function openNotebook(page, name) {
  const row = page.getByText(name, { exact: true }).last()
  await row.waitFor({ state: 'visible', timeout: 20_000 })
  await row.click()
  await page.locator('.dsh-bsb-ipynb-root').waitFor({ state: 'visible', timeout: 30_000 })
}

async function waitForSavedOutput(notebookPath, marker) {
  const deadline = Date.now() + 25_000
  let last = ''
  while (Date.now() < deadline) {
    try {
      const notebook = JSON.parse(await readFile(notebookPath, 'utf8'))
      last = JSON.stringify(notebook)
      const cell = notebook.cells && notebook.cells[0]
      const output = cell && Array.isArray(cell.outputs)
        ? cell.outputs.some((entry) => JSON.stringify(entry).includes(marker))
        : false
      if (output && Number.isInteger(cell.execution_count) && cell.execution_count > 0) return
    } catch (error) {
      last = String(error)
    }
    await sleep(400)
  }
  throw new Error(`the executed output was not autosaved within 25 s; last file state: ${last.slice(0, 1500)}`)
}

async function main() {
  const marker = `E2E_MARKER_${Date.now()}_${process.pid}`
  const notebookName = `e2e-${process.pid}-${Date.now()}.ipynb`
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-bsb-ipynb-e2e-'))
  const profileDir = path.join(home, 'profiles', PROFILE)
  const workspaceDir = path.join(home, 'workspace')
  const notebookPath = path.join(workspaceDir, notebookName)
  let server = null
  let browser = null
  let page = null
  let failure = null

  try {
    log(`pinned DSH ${PINNED_DSH}, dsh-better-sidebar ${PINNED_BSB}`)
    const version = (await runDsh(['--version'], { timeout: TIMEOUT_MS })).stdout.trim()
    assert.equal(version, PINNED_DSH, `the installed DSH is ${version}; this test pins ${PINNED_DSH}`)

    log('creating an isolated DSH home and profile')
    const env = { DSH_HOME: home }
    await runDsh(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], { env })
    await writeFile(path.join(profileDir, 'cordis.patch.yml'), [
      '- id: locale',
      '  name: "@deepseek-ai/dsh-client-locale"',
      '  config:',
      '    preference: en',
      '- id: ui-settings-account',
      '  name: "@deepseek-ai/dsh-client-ui-settings-account"',
      '  config:',
      '    version: 1',
      '    step: done',
      '    purpose: development',
      '    process: detailed',
      '    completion: completed',
      '    usage: detailed',
      '    developerTools: true',
      '- id: better-sidebar',
      '  name: dsh-better-sidebar',
      '  config:',
      '    viewersEnabled:',
      '      code: true',
      '',
    ].join('\n'), 'utf8')

    log('installing the plugin and the pinned Better Sidebar (pnpm)')
    await runDsh(['plugin', '--profile', PROFILE, 'add', ROOT, `dsh-better-sidebar@${PINNED_BSB}`], { env })
    const bsbManifest = JSON.parse(await readFile(
      path.join(profileDir, 'node_modules', 'dsh-better-sidebar', 'package.json'),
      'utf8',
    ))
    assert.equal(bsbManifest.version, PINNED_BSB, 'the E2E profile must contain the pinned Better Sidebar')

    // A fresh DSH_HOME would otherwise bootstrap the user's global default
    // workspace. Seed one isolated registry entry instead so the file tree is
    // rooted inside this temporary home.
    await mkdir(workspaceDir, { recursive: true })
    const workspaceId = randomUUID()
    const workspacePath = await realpath(workspaceDir)
    const now = new Date().toISOString()
    await mkdir(path.join(home, 'storages'), { recursive: true })
    await writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        defaultWorkspaceId: workspaceId,
        workspaceIds: [workspaceId],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
      tables: {
        workspaces: {
          [workspaceId]: {
            path: workspacePath,
            title: 'e2e-workspace',
            sessionIds: [],
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    }, null, 1), 'utf8')
    await writeFile(notebookPath, JSON.stringify(notebookFor(marker), null, 1), 'utf8')
    log(`opening ${notebookName} in the isolated e2e-workspace`)

    log('booting dsh web')
    server = spawn(cli.command, [...cli.prefix, '--profile', PROFILE, '--no-open', '--port', '0'], {
      cwd: ROOT,
      env: { ...process.env, ...cli.env, DSH_HOME: home },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const url = await waitForServerUrl(server)
    log(`web ready at ${url.replace(/token=[^&]+/, 'token=…')}`)

    browser = await launchBrowser()
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.setDefaultTimeout(45_000)
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error))

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })
    await page.waitForTimeout(2_000)
    await dismissPreview(page)

    // The settings panel's first read: the same authenticated host route must
    // answer from the page before the notebook is opened.
    const config = await page.evaluate(async () => (await fetch('ipynb/config')).json())
    assert.equal(config.ok, true)
    assert.ok(Number.isInteger(config.value.idleMinutes), 'config reports an integer idle timeout')

    log('asserting the viewer settings panel')
    await assertSettingsPanel(page)

    await openRightSidebar(page)
    await openFilesPage(page)
    await openNotebook(page, notebookName)

    log('running the notebook cell')
    await page.getByRole('button', { name: /^(运行单元格|Run cell)$/ }).first().click()
    await page.locator('.dsh-bsb-ipynb-root').getByText(marker, { exact: false }).first().waitFor({ timeout: 90_000 })
    await waitForSavedOutput(notebookPath, marker)

    if (pageErrors.length) {
      throw new Error('page errors during the run:\n' + pageErrors.map((error) => error.stack || error.message).join('\n'))
    }
    log('PASS: the notebook opened, executed and autosaved through the real DSH + Better Sidebar')
  } catch (error) {
    failure = error
    if (page) {
      try {
        await page.screenshot({ path: path.join(os.tmpdir(), 'dsh-bsb-ipynb-e2e-failure.png'), fullPage: false })
      } catch { /* no page */ }
    }
    throw error
  } finally {
    try { if (browser) await browser.close() } catch { /* ignore */ }
    await stopServer(server)
    if (!failure || process.env.DSH_E2E_KEEP === '1') {
      if (process.env.DSH_E2E_KEEP === '1') log(`kept DSH_HOME at ${home}`)
      else await rm(home, { recursive: true, force: true }).catch(() => {})
    } else {
      log(`failure: kept DSH_HOME at ${home}`)
      log(`failure screenshot (if any): ${path.join(os.tmpdir(), 'dsh-bsb-ipynb-e2e-failure.png')}`)
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[e2e] FAIL: ${error.stack || error.message}\n`)
  process.exitCode = 1
})
