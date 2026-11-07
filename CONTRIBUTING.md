# Contributing

Thanks for taking the time to improve `dsh-bsb-ipynb`.

## Development Setup

- Node.js >= 20
- Python with `jupyter_client`, `ipykernel` and `nbformat`
- DSH with dsh-better-sidebar only for manual UI testing

```bash
python3 -m pip install jupyter_client ipykernel nbformat
node --check index.js lib/*.js client.js
python3 -m py_compile python/bridge.py
npm test
```

There is no build step: `client.js` is loaded as-is by DSH and the host side is
plain ESM.

## Before You Start

- Open an issue for significant behavior changes or new dependencies so the
  design can be discussed first.
- Keep the browser bundle hand-written and dependency-free; do not add a
  bundler.
- Do not commit `.DS_Store`, `__pycache__/`, `node_modules/`, generated caches
  or absolute local paths.
- For security issues, follow [SECURITY.md](SECURITY.md) instead of opening an
  issue.

## Tests

`npm test` runs the full `node:test` suite, including integration tests against
a real Python kernel. Real-kernel tests skip automatically when no candidate
interpreter provides `jupyter_client`/`ipykernel`; `test/control-symlink.test.mjs`
contains case-insensitivity tests that only run on case-insensitive file
systems (such as macOS APFS). Set `DSH_IPYNB_TEST_PYTHON` to test a specific
interpreter.

Please add regression tests for behavior changes, keep tests deterministic,
and avoid fixed long sleeps where the existing helpers can wait for a condition
instead.

## Style

- ESM, 2-space indentation, single quotes.
- Match the style of the surrounding code; keep comments purposeful.
- Prefer small, focused changes over broad refactors.

## Pull Requests

- Fork the repository, create a topic branch and keep commits focused.
- Describe what changed and how it was tested; link related issues.
- Update README or limits when behavior changes.
- Include a screenshot or GIF for visible UI changes.
- By submitting a pull request you agree that your contribution is licensed
  under the MIT License.
