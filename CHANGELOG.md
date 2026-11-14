# Changelog

All notable changes to `dsh-bsb-ipynb` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-14

### Added

- **Viewer settings panel** in Better Sidebar (`Settings → Side card`) for the
  autosave interval, default interpreter and kernel idle timeout, with
  interpreter availability details.
- **New notebook file action** on directory rows in the Better Sidebar tree,
  backed by the new `POST /ipynb/create` route. Names are allocated race-safely
  as `Untitled.ipynb`, `Untitled 1.ipynb`, and so on.
- **Notebook tab actions** for Run all, Interrupt and Restart in the editor
  header.
- **Kernels page** as a Better Sidebar tab: live kernels for the current
  workspace with state, interpreter, idle time, Open/Stop/Restart controls and a
  New notebook action, backed by `GET /ipynb/kernels`.
- **Pinned compatibility E2E**: an isolated DSH Web profile boots with
  `dsh-better-sidebar@0.32.1`, drives the settings panel, header actions, cell
  execution, the Kernels page and the directory New notebook action, and runs in
  CI on Ubuntu.

### Changed

- The plugin now targets **DSH 0.2.2-rc.2+** and **dsh-better-sidebar 0.32.x**.
  The package declares `dsh.manifestVersion: 1`, and the client checks the
  sidebar version and required `hostRouteUrl` / `fileActions` / `tabActions`
  features at startup.
- Autosave delay and kernel idle timeout are runtime settings; the environment
  variables remain deployment defaults.
- The notebook theme continues to resolve through DSH tokens and Shiki
  variables, including the new settings and Kernels surfaces.

### Fixed

- Hardened kernel restart, shutdown, readiness and protocol recovery, including
  Windows subprocess reaping and orphaned connection files.
- Hardened notebook reads and saves: bounded 32 MiB JSON structure/capacity,
  64 MiB body/line limits, UTF-8 accounting, BOM handling, ANSI output,
  same-directory atomic writes and stale temporary-file cleanup.
- Fixed reload, shared `display_id` updates, deferred clears, capacity preflight
  and kernel-status races in the viewer.
- Fixed Windows interpreter discovery, save blocking, case-variant control
  paths, UNC/drive image paths and platform shortcuts.
- Expanded regression coverage for JSON budgets, kernel lifecycle, theme
  tokens, Windows paths and the pinned browser flow.

### Breaking

- `dsh-better-sidebar` 0.30.x and older are no longer supported; the client
  fails fast with an actionable error. On the plugin side, DSH 0.2.2-rc.1 is
  below the new `engines.dsh` floor because the supported sidebar line requires
  rc.2+.

## [0.1.0] - 2026-11-07

Initial public release: notebook rendering, in-place cell editing, persistent
Python kernels, DSH theme and locale integration, atomic save with optimistic
concurrency, and workspace-contained file access. See the
[v0.1.0 release](https://github.com/kexiongwen/dsh-bsb-ipynb/releases/tag/v0.1.0)
for the original notes.

[0.2.0]: https://github.com/kexiongwen/dsh-bsb-ipynb/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kexiongwen/dsh-bsb-ipynb/releases/tag/v0.1.0
