# Contributing

This project is maintained by one person; focused issues and pull requests are
welcome. For security issues use [SECURITY.md](SECURITY.md), not the issue tracker.

## Development

- Node.js >= 20
- Python with `jupyter_client`, `ipykernel` and `nbformat`
- DSH **0.2.2-rc.2+** with **dsh-better-sidebar 0.32.x** for the E2E lane
  (the client guard rejects older sidebar builds)
- Google Chrome and the dev-only `playwright` package for `npm run test:e2e`

There is no build step: `client.js` is loaded as-is and the host side is plain ESM.

```bash
# macOS / Linux
python3 -m pip install jupyter_client ipykernel nbformat
# Windows
python -m pip install jupyter_client ipykernel nbformat

for file in index.js lib/*.js client.js; do node --check "$file"; done
python -m py_compile python/bridge.py
npm test
npm install          # Playwright is dev-only; the unit suite needs no dependencies
npm run test:e2e     # pinned DSH + Better Sidebar browser smoke test
```

`npm run test:e2e` creates an isolated `DSH_HOME`, boots the pinned DSH Web
profile, and drives the settings panel, editor-header actions and file-tree
actions through Chrome. It accepts `DSH_E2E_DSH_BIN`, or uses
`DSH_INSTALL_DIR` / `DSH_NODE_EXECUTABLE` when run inside DSH Desktop. Keep
`PINNED_DSH` and `PINNED_BSB` in `test/e2e/run.mjs` in sync when upgrading.

After changing `client.js`, reload the plugin and hard-refresh the page
(`Ctrl/Cmd+Shift+R`). UI strings live in the `STRINGS` table in `client.js`;
`locale/*.json` only provides plugin-market metadata.

Real-kernel tests skip when no candidate interpreter has the Python dependencies;
set `DSH_IPYNB_TEST_PYTHON` to choose one. On Windows, set `DSH_IPYNB_PYTHON` to an
absolute `python.exe` path when discovery cannot find the interpreter. The ~28
case-insensitivity tests only run on case-insensitive file systems that allow
symlinks (macOS APFS; Windows NTFS with Developer Mode or elevation). CI covers
`ubuntu-latest`, `windows-latest` and `macos-latest`. Add regression tests for
behavior changes and keep tests deterministic.

## Pull Requests

- Fork, branch from `main`, keep changes focused.
- Describe what changed and how it was tested.
- Do not add a bundler or runtime dependency; keep `client.js` hand-written.
- Do not commit secrets, absolute local paths or generated caches.
- Contributions are accepted under the MIT License.
