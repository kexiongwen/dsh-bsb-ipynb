import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { registerIpynbRoutes } from '../lib/routes.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-ipynb-image-route-'))
  await mkdir(path.join(directory, 'workspace'))
  const workspace = await realpath(path.join(directory, 'workspace'))
  const outside = path.join(directory, 'outside')
  await mkdir(outside)
  let handler
  registerIpynbRoutes({
    sessions: { get: (id) => id === 's1' ? { header: { cwd: workspace } } : undefined },
    connection: { requestRejection: () => undefined },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }, {})
  const server = createServer((req, res) => { void handler(req, res) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  t.after(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  const request = (target, options = {}) => {
    const url = new URL(`http://127.0.0.1:${address.port}/ipynb/image`)
    url.searchParams.set('sessionId', 's1')
    url.searchParams.set('path', target)
    return fetch(url, options)
  }
  return { workspace, outside, request }
}

test('the image route streams workspace images with MIME and SVG safety headers', async (t) => {
  const h = await setup(t)
  await writeFile(path.join(h.workspace, 'plot.png'), PNG)
  await writeFile(path.join(h.workspace, 'plot.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  await writeFile(path.join(h.workspace, 'notes.txt'), 'not an image')

  const png = await h.request('plot.png')
  assert.equal(png.status, 200)
  assert.equal(png.headers.get('content-type'), 'image/png')
  assert.equal(png.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(png.headers.get('referrer-policy'), 'no-referrer')
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG)

  const svg = await h.request('plot.svg')
  assert.equal(svg.status, 200)
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml')
  assert.equal(svg.headers.get('content-security-policy'), "sandbox; object-src 'none'")
  await svg.arrayBuffer()

  const text = await h.request('notes.txt')
  assert.equal(text.status, 400)
  const error = await text.json()
  assert.equal(error.error.code, 'bad-request')

  const wrongMethod = await h.request('plot.png', { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  await wrongMethod.arrayBuffer()
})

test('the image route rejects absolute, relative and symlink workspace escapes', async (t) => {
  const h = await setup(t)
  const outsideImage = path.join(h.outside, 'secret.png')
  await writeFile(outsideImage, PNG)
  await writeFile(path.join(h.workspace, 'inside.png'), PNG)

  for (const target of [outsideImage, '../outside/secret.png']) {
    const response = await h.request(target)
    assert.equal(response.status, 403, target)
    const error = await response.json()
    assert.equal(error.error.code, 'path-outside-root')
  }

  try {
    await symlink(outsideImage, path.join(h.workspace, 'escape.png'), 'file')
    await symlink(path.join(h.workspace, 'inside.png'), path.join(h.workspace, 'alias.png'), 'file')
  } catch (error) {
    t.diagnostic(`symlink capability unavailable: ${error.code || error.message}`)
    return
  }
  const escaped = await h.request('escape.png')
  assert.equal(escaped.status, 403)
  await escaped.arrayBuffer()

  const alias = await h.request('alias.png')
  assert.equal(alias.status, 200, 'an in-workspace symlink remains usable')
  assert.deepEqual(Buffer.from(await alias.arrayBuffer()), PNG)
})
