# Changelog

## Unreleased

## 0.2.0-alpha.0

Breaking-ish alpha cut (still `alpha` dist-tag). Public lifecycle verb is now **`acquire`** (was `ensure`).

### Breaking

- Rename public `ensure` → `acquire` (`acquireIfNeeded`, CLI `acquire`, `db:acquire`, `createAcquireTask` / `afterAcquire`, `resolveAcquireSkip`)
- TEMPLATE workers: `cloneWorkerDatabase` (was `ensureWorkerDatabase`)
- `ensureHostRunning` is no longer exported from `@cedarjs/pg` (host bootstrap stays internal; use `acquire` / `adminUrl`)

### Added

- CLI: `cedarpg run --mode=dev|test -- <cmd…>` acquires then overwrites child `DATABASE_URL` (Nx / e2e / API wrappers)
- CLI: `acquire --force` / `run --force` sets `CEDAR_PG_FORCE=1` (escape hatch only; `run` always injects child env)
- Test TEMPLATE API: `adminUrl`, `markTemplate`, `cloneFromTemplate`, `cloneFromTemplateIfNeeded`
- Optional Jest / Vitest TEMPLATE adapters (`@cedarjs/pg/jest/template`, `@cedarjs/pg/vitest/template`) via `createGlobalSetup({ migrate })`
- Shared `cedarPgLifecycleTargets` for Vite+ / Nx; Nx adds `cedarPgRunCommand` + `relativeEnvFile`
- `createAcquireTask({ afterAcquire })` for db:ready / migrate compose
- `loadDevEnv({ overwrite })` + `@cedarjs/pg/dev-env`; `loadTestEnv` accepts `{ overwrite: true }`
- Public: `envFilePath(root, mode)` for stable `.cedarpg/<mode>.env` paths
- Opinionated CI ephemeral host via env (`CI=true` / `CEDAR_PG_EPHEMERAL_HOST`)
- PG adapter smoke (`vp run smoke:pg`), binary-only autopg CI install, `setup-autopg` composite action

### Fixed

- Role passwords keyed by `roleName` so TEMPLATE clones that reuse a role keep working
- Treat dotenv/template placeholder URLs as non-external escape hatch
- Clear stale mode env on dispose
- Default-only exports in test adapters

### Contracts (unchanged)

- CLI binary: `cedarpg`; npm: `@cedarjs/pg` (`alpha` tag)
- State dirs: `.cedarpg` (worktree) and `~/.cedarpg/registry`
- Password salt: opaque `cedar-pg\\0` + `roleName` (scheme v2)

## 0.1.0-alpha.1

Trusted Publisher packaging bump (no feature changelog).

## 0.1.0-alpha.0

Initial alpha of **cedar-pg**, published on npm as `@cedarjs/pg` (CLI: `cedarpg`).

- Worktree-scoped Postgres databases via host [autopg](https://github.com/automagik-dev/autopg) (`dev` persist / `test` dispose)
- CLI: `ensure`, `dispose`, `gc`, `print-url`
- Adapters: Vite+ tasks, Nx target hints, Vitest `globalSetup`, Jest setup/teardown
- Jest workers: `@cedarjs/pg/test-env` + `@cedarjs/pg/jest-teardown` (globalSetup cannot set worker env)
- Public exports: `STATE_DIRNAME`, `loadTestEnv` for framework hosts (avoid hardcoding `.cedarpg`)
- Registry-backed `gc` for orphan worktrees; lease-gated dispose (drop-then-forget)
- `ensureIfNeeded` policy with external-URL escape hatch
- Postinstall installs pinned autopg `v3.0.7` when missing

### Known limitations

- Alpha: APIs may change
- No Windows-first support claims in this alpha

### Contracts

- CLI binary: `cedarpg`; npm: `@cedarjs/pg`
- State dirs: `.cedarpg` (worktree) and `~/.cedarpg/registry` (product-owned; not under `~/.autopg/`)
- Password salt: opaque `cedar-pg\\0` + `roleName` (scheme v2); bump scheme id to change
