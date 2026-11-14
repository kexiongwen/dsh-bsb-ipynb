// Regenerate client.katex.js from a pinned KaTeX distribution.
//
// The plugin ships no build step; this script is a one-off vendoring tool for
// the lazy math chunk. Install the dev dependency, run the script, and commit
// the regenerated file together with any version change:
//
//   npm install
//   node scripts/build-katex-chunk.mjs
//
// The chunk is the KaTeX UMD build wrapped in the DSH package-local chunk
// registration; the browser loads it on demand through require.async and the
// page keeps using the host's already-loaded KaTeX stylesheet and fonts.

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_VERSION = '0.19.1'
const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const PACKAGE_CHUNK = 'client.katex.js'

const sourcePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'node_modules', 'katex', 'dist', 'katex.min.js')
const manifestPath = path.join(path.dirname(sourcePath), '..', 'package.json')
const licensePath = path.join(path.dirname(sourcePath), '..', 'LICENSE')

const source = await readFile(sourcePath, 'utf8')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest.version !== EXPECTED_VERSION) {
  throw new Error(`expected katex@${EXPECTED_VERSION}, found ${manifest.version}`)
}
const license = await readFile(licensePath, 'utf8')
const digest = createHash('sha256').update(source).digest('hex')
// A pinned hash makes an unexpected upstream tarball visible in review.
const expectedDigest = 'fa140498b8cfc8302cbe5e7cb1bdbc1f952bc38b3fa258ede09e73edbf9a74bc'
if (expectedDigest !== 'EXPECTED_DIGEST_PLACEHOLDER' && digest !== expectedDigest) {
  throw new Error(`katex.min.js digest ${digest} does not match ${expectedDigest}`)
}

const header = `/*!
 * dsh-bsb-ipynb — vendored KaTeX chunk (lazy-loaded only when a notebook
 * contains math; see scripts/build-katex-chunk.mjs).
 *
 * KaTeX v${manifest.version} — https://katex.org
 * Copyright (c) 2013-2020 Khan Academy and other contributors
 * MIT License — see NOTICE (katex.min.js sha256 ${digest}).
 *
 * Generated file: do not edit by hand.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bsb-ipynb',
  chunk: '${PACKAGE_CHUNK}',
  factory: function katexChunk() {
    const module = { exports: {} };
    const exports = module.exports;
`

const footer = `
    return module.exports;
  },
});
`

const chunk = header + source + footer
await writeFile(path.join(ROOT, PACKAGE_CHUNK), chunk)
process.stdout.write(
  `wrote ${PACKAGE_CHUNK} (${chunk.length} bytes, katex ${manifest.version}, sha256 ${digest})\n` +
  `license: ${license.split('\n')[0]}\n`,
)
