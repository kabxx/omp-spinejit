# Spine for OMP (`@kabxx/omp-spinejit`)

[![arXiv](https://img.shields.io/badge/arXiv-2610.37224-b31b1b.svg)](https://arxiv.org/abs/2610.37224) [![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

English | [简体中文](README.zh-CN.md)

> This repository maintains the OMP adapter, uses the upstream Spine SDK, and includes prebuilt `dist/omp/` artifacts for GitHub installs. [GhabiX/dsh-spinejit README](https://github.com/GhabiX/dsh-spinejit/blob/5e4f9153a5ad37158600ac71d4a85f1bb8d6310a/README.md) · [Spine SDK](https://github.com/GhabiX/spine-plugin/tree/main/packages/sdk)

**Your agent's context, shaped like its task.**

Long-horizon tasks unfold as nested subtasks, yet an agent's context is a flat linear stream where finished explorations and dead ends pile up alongside unfinished work. **Spine** places OMP execution under a persistent work tree (**`SpineTree`**, acting as the structural spine of long-horizon work). The agent opens subtasks with explicit goals, switches or closes them locally (`Open`, `Close`, `Next`), and delegates parallel subtrees when needed (`Spawn`). Before each main model call, Spine compiles `SpineTree` into minimal effective context—keeping active work in full while folding finished subtasks into their returned conclusions, without breaking prefix caching.

## Highlights

- **Unified work-tree control.** Sequential local steps (`Open` / `Close` / `Next`) and parallel child agents (`Spawn`) are managed together in one `SpineTree`, avoiding unnecessary cross-session subagent overhead on serial work.
- **No separate summarization pass on close.** Closing a subtask folds its intermediate turns immediately using the conclusion written by the agent while full task context is still fresh. Detailed history stays in the session log.
- **Prefix cache keeps hitting.** Completed inner subtasks collapse at the active suffix, leaving preceding parent context byte-for-byte unchanged.
- **Live tree view in the TUI.** Renders `SpineTree` above the OMP input box. Open `/spine-tree` to browse nodes, saved memory, and past summaries.

## Install

Install from npm with OMP's built-in installer.

```bash
omp install @kabxx/omp-spinejit
```

To install directly from GitHub, use the repository address.

```bash
omp install github:kabxx/omp-spinejit
```

Restart OMP and open a new session with `/new`. Verify installation with `omp plugin list`. Append `#<commit>` to the GitHub spec to pin an exact revision. OMP resolves the SDK and its WASM from npm at install time.

For a local build, run `npm pack` with Node.js ≥22.19.0 and Bun ≥1.4.4 after `bun install --frozen-lockfile`. Install the resulting tarball using `omp install '@kabxx/omp-spinejit@file:/absolute/path/to/package.tgz'` and a fresh tarball path for each build.

## Compatibility, Permissions & Scope

- **Category.** Memory & Context (`记忆与上下文`).
- **Supported host.** The OMP TUI on official OMP `19.0.0`. GitHub installation and session recovery are tested on Linux.
- **Runtime requirements.** OMP `19.0.0` and the package dependency `@spinejit/spine-sdk@0.1.4` (SDK v3). Building from source uses Node.js ≥22.19.0 and Bun ≥1.4.4.
- **Permissions & external services.** Spine's context projection runs locally via the embedded Rust/WASM runtime (`@spinejit/spine-sdk`). It requires no additional API key or service. OMP's configured model still handles inference and compaction.
- **Extension interaction.** Use one Spine adapter per session. Disable other extensions that register `context` or `session_before_compact` hooks. For an older Spine or Pi journal that the adapter rejects, keep the journal and start with `/new`.
- **Upstream project.** See [GhabiX/spine-plugin](https://github.com/GhabiX/spine-plugin), [SpineCodex](https://github.com/GhabiX/SpineCodex), and [arXiv:2610.37224](https://arxiv.org/abs/2610.37224).

## How it works

- Each OMP main turn is one Spine sampling. The extension materializes the active work tree for the model through OMP's native context pipeline and settles the sampling when the turn ends. The OMP journal holds the source checkpoints and sampling records used to restore the tree on resume.
- The Spine tools are available as OMP discoverable devices (`xd://spine_open`, `xd://spine_close`, `xd://spine_next`, and `xd://spine_spawn`). The model reads a device for its schema and writes JSON arguments to call it.
- Spawn starts child OMP processes after their births are committed. A child returns its last committed reply as memory. The parent receives each outcome as a durable arrival, which can be replayed on restart. Recovery can offer Continue for an eligible child or Retry when a fresh attempt is allowed.
- Spine uses the projected context for OMP auto-compaction and `/compact`. Native `/clear` starts a fresh Spine root while preserving the OMP transcript. [OMP host contract](doc/HOST.md)

OMP loads the extension from `omp.extensions`. For programmatic integration, use `createOmpExtension()` from `@kabxx/omp-spinejit/extension`. The `@kabxx/omp-spinejit/tree-view` export provides the tree-view event contract.

## The tree on screen

The tree is drawn by `@spinejit/spine-sdk/view` once the agent has opened a task.

- OMP pins the live tree above the input box.
- `/spine-tree` opens a read-only browser for nodes, saved memory, and past summaries. Use Up/Down or PgUp/PgDn to move, Enter to read, and Esc to go back. Use the native `/tree` command to switch OMP branches.

## Known limits

- Start a fresh session after installation. The adapter rejects older Spine record formats and leaves the original journal intact.
- A slow `/compact` can return before its summary is ready. The adapter applies the result once the session is idle and the original branch is still current.
- Native OMP owns model retries. Spawn Continue and Retry apply to child processes and depend on the child's saved state.

## Tests

Tests run the official OMP CLI in isolated profiles with a scripted model. The install smoke checks discovery through the installed package manifest, an Open, then a recovered Close after process restart. It installs an npm tarball by default and accepts a Git install spec through `OMP_SMOKE_INSTALL_SPEC`.

```bash
bun install --frozen-lockfile
npm run check
npm test
OMP_BIN=/absolute/path/to/omp npm run test:stock
OMP_BIN=/absolute/path/to/omp npm run test:install
```

Run `npm run build` before committing source changes and include the updated `dist/omp/` artifacts for GitHub installs. `test:stock` targets official OMP. `test:native` also includes probes for the former custom host. Set `OMP_NATIVE_TIMEOUT_MS` for slower PTY environments. `OMP_NATIVE_EVIDENCE_DIR` and `OMP_SMOKE_DIR` retain the logs and evidence from their respective suites. For a Bun-hosted OMP CLI, set `OMP_BIN` to the Bun executable and `OMP_BIN_ARGS` to a JSON array containing the absolute path to the CLI entry.

## License

Licensed under the [Apache License 2.0](LICENSE).
