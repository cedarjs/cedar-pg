# Changelog

## 0.1.0-alpha.0

Initial alpha of **cedar-pg**, published on npm as `@cedarjs/pg` (CLI: `cedarpg`).

- Worktree-scoped Postgres databases via host [autopg](https://github.com/automagik-dev/autopg) (`dev` persist / `test` dispose)
- CLI: `ensure`, `dispose`, `gc`, `print-url`
- Adapters: Vite+ tasks, Nx target hints, Vitest `globalSetup`, Jest setup/teardown
- Registry-backed `gc` for orphan worktrees; lease-gated dispose (drop-then-forget)
- `ensureIfNeeded` policy with external-URL escape hatch
- Postinstall installs pinned autopg `v3.0.7` when missing

### Known limitations

- Alpha: APIs may change
- No Windows-first support claims in this alpha

### Contracts

- CLI binary: `cedarpg`; npm: `@cedarjs/pg`
- State dirs: `.cedarpg` (worktree) and `~/.cedarpg/registry` (product-owned; not under `~/.autopg/`)
- Password salt: opaque `cedar-pg\\0` (scheme v1); bump scheme id to change
