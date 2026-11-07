# Contributing

This project is maintained by one person; focused issues and pull requests are
welcome. For security issues use [SECURITY.md](SECURITY.md), not the issue tracker.

## Development

- Node.js >= 20
- Python with `jupyter_client`, `ipykernel` and `nbformat`
- DSH with dsh-better-sidebar only for manual UI checks

There is no build step: `client.js` is loaded as-is and the host side is plain ESM.

```bash
python3 -m pip install jupyter_client ipykernel nbformat
node --check index.js lib/*.js client.js
python3 -m py_compile python/bridge.py
npm test
```

Real-kernel tests skip when no candidate interpreter has the Python dependencies;
set `DSH_IPYNB_TEST_PYTHON` to choose one. The ~28 case-insensitivity tests only
run on case-insensitive file systems (such as macOS APFS). Add regression tests for
behavior changes and keep tests deterministic.

## Pull Requests

- Fork, branch from `main`, keep changes focused.
- Describe what changed and how it was tested.
- Do not add a bundler or runtime dependency; keep `client.js` hand-written.
- Do not commit secrets, absolute local paths or generated caches.
- Contributions are accepted under the MIT License.
