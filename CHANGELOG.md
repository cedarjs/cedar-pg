# Changelog

## Unreleased

### Added

- CLI: `cedarpg run --attach --mode=dev|test -- <cmd…>`, attach-only run. It reads the existing lease and sets child `DATABASE_URL` (+ `TEST_DATABASE_URL` in test). It never acquires, never runs role/database DDL, and never starts the host. It fails before the child starts when there is no lease or nothing listens on the leased port.
- `acquire({ fresh: true })` / `acquireIfNeeded({ fresh: true })` drop every database owned by this worktree's role for that mode first. That covers the leased DB, TEMPLATE clones, and leftovers from crashed runs, and it works even when the lease file is gone. The database is then created again empty.
- `cloneWorkerDatabase({ reset })` (Jest / Vitest TEMPLATE) resets the worker clone at the start of every test file. The default `"truncate"` runs `TRUNCATE ... RESTART IDENTITY` over every user table, skipping system schemas, temp tables, and extension-owned tables. Rows from earlier files in the worker are gone, and `serial` / identity IDs restart at 1, so suites that expect `id = 1` work on a reused clone. This also clears rows that `migrate` seeded into the TEMPLATE. Pass `reset: "none"` to keep the clone's rows and reset on your own. A skipped clone (external URL, `CEDAR_PG=0`) is never truncated.
- `cloneFromTemplate({ reuse: true })` keeps an existing `<template>_c_<name>` owned by the lease role instead of failing with `database already exists`. A clone name owned by any other role still fails, with the owner in the message.

- Warn when the installed autopg is older than the pin (`scripts/autopg-version`, inlined at build). The first host attach of each process (`acquire`, `cedarpg run`, TEMPLATE setup) and `postinstall` print the upgrade commands (pinned `install.sh`, then `autopg update`). It is a warning only: cedar-pg never upgrades a local host, because that restarts the host every worktree shares.

### Changed

- `scripts/ci-install-autopg.sh` (postinstall CI path and the `setup-autopg` Action) reuses `~/.local/bin/autopg` only when it reports exactly the pinned version; any other binary is replaced. It used to skip whenever any autopg was present, so cached runners stayed on an old release. With `CI=true CEDAR_PG_INSTALL_AUTOPG=1`, postinstall now runs the installer even when `~/.local/bin/autopg` already exists, so a stale cached binary is replaced (binaries elsewhere still only get the upgrade warning).
- Nx canonical shape: one `db:ready` acquires + migrates. Children either preload `@cedarjs/pg/dev-env` or use `cedarpg run --attach` (was `cedarpg run --force` per child). Children no longer run DDL, so concurrent dev servers and workers no longer race. Plain `cedarpg run` is unchanged for one-shot acquire + exec. The README Nx section is rewritten as a generic setup guide.
- TEMPLATE setup (`setupTemplateMode`, Jest / Vitest `createGlobalSetup`) acquires with `fresh: true`. Leftover TEMPLATE / clone databases from a crashed run are dropped before `migrate`, so migrate always starts empty and consumers need no pre-cleanup.
- TEMPLATE `cloneWorkerDatabase` truncates at the start of **every** test file by default, the first file on a fresh clone included, not only when it reuses a clone. Each worker clone used to start with the TEMPLATE's rows. Now every file starts with empty user tables, and rows that `migrate` seeded into the TEMPLATE are wiped, including bookkeeping tables such as `_prisma_migrations`. Migration: if your tests depend on seeded rows, either seed them in your worker setup after `cloneWorkerDatabase()`, or pass `cloneWorkerDatabase({ reset: "none" })` and reset on your own.

- autopg pin bumped `v3.0.7` → `v3.2.2` (`scripts/autopg-version`; postinstall, `ci-install-autopg.sh`, and the `setup-autopg` Action follow it). v3.2 fixes a host that hung after days under load (stderr drain), keeps the pm2 registration across `pm2 resurrect`, and makes `autopg install` / `restart` wait for readiness. Postinstall only installs autopg when it is missing (except the forced CI path above); run `autopg update` to move an existing host.
- Local host recovery follows v3.2 `autopg restart`: exit 0 means ready, and a pm2-less or non-pm2 host exits 1, after which cedar-pg revives the registered postmaster as before. The v3.0.x "respawned daemon" exit-0 special case is removed; on a pm2-less host still running autopg v3.0.x, recovery waits up to 10s before the revive.

### Removed

- The `@cedarjs/pg/nx` entry is removed: `cedarPgRunCommand`, `cedarPgNxTargets`, the deprecated `nxTargetHints`, `CEDAR_PG_NX_ACQUIRE_DEV` / `CEDAR_PG_NX_ACQUIRE_TEST` / `CEDAR_PG_NX_DISPOSE_TEST`, `relativeEnvFile`, the `NxTargetHint` / `CedarPgNxTargetsOptions` types, and its `envFilePath` re-export. Nx targets are plain `cedarpg` command strings. Migration: replace `cedarPgRunCommand(mode, cmd)` with the string `cedarpg run --mode=<mode> -- <cmd>`. Nx `db:acquire` / `db:acquire-test` / `db:dispose-test` targets were greenfield scaffolding; write one `db:ready` target instead (see README → Nx). Import `envFilePath` from `@cedarjs/pg`. Replace Nx `envFile: relativeEnvFile(mode)` with the `@cedarjs/pg/dev-env` preload or `cedarpg run --attach`, since an ambient `.env` beat `envFile`. Vite+ `cedarPgTasks()` is unchanged.

### Fixed

- README / `@cedarjs/pg/vite-plus` Vite+ example: `dev` is now `cedarpg run --attach --mode=dev -- vp dev` (with `cache: false`). Vite+ `dependsOn` does not forward env and task `env` only passes through the `vp` process env, so the old `command: "vp dev"` + `env: ["DATABASE_URL"]` never saw the leased URL.
- Ephemeral host cold start no longer deletes `/dev/shm/PostgreSQL.*` and `pgserve-*`. Those are live shared-memory segments of every Postgres on the machine. Running with `CI=true` or `CEDAR_PG_EPHEMERAL_HOST=1` next to a registered local host deleted that host's segment, and every new connection to it then failed with `58P01 could not open shared memory segment` until it was restarted. Cold start now removes only cedar-pg's own leftover data dir (`/dev/shm/cedar-pg-<uid>`). The `53100` / quota hint no longer recommends `rm /dev/shm/PostgreSQL.*`.
- TEMPLATE `cloneWorkerDatabase` reuses the worker's `<template>_c_<workerId>` in Postgres across Jest test files. The `0.2.0-beta.0` fix cached the clone on `globalThis`, but Jest resets `globalThis` and the module registry for each test file. So the second file in a worker still ran `CREATE DATABASE` and failed with `database already exists`. The in-memory memo is removed; the database is the source of truth. As a result, calling it again with a different `root` / `name` in one process no longer throws: each call clones or reuses its own name. `smoke:pg` now runs two Jest files in one worker, after a seeded crashed run.

## 0.2.0-beta.1

Revive a registered autopg host without pm2.

### Fixed

- Local acquire on a registered host no longer requires pm2. After `autopg restart` (including exit 0 “respawned daemon” with no listener), cedar-pg revives the **same** port / `~/.autopg/data` with detached `autopg postmaster` instead of `autopg install`. `status=stopped` + `runtime.live=true` is still not a reinstall signal — TCP accept is the attach gate. Fail-closed errors list what was tried; they do not ask you to install pm2.
- Registered revive waits for a live `postmaster.pid` owner of the data dir (pm2 still recovering, or a concurrent acquire that won the lock) instead of failing or racing it. It also skips the revive when `autopg status --json` reports no `dataDir`, rather than guessing autopg's paths, and leaves out `--socket-dir` when none is reported. The revived postmaster appends its output to `cedarpg-postmaster.log` in autopg's `logsDir`.
- Admin connections retry Postgres `57P03` ("the database system is starting up" / in recovery) for up to 30s. Postgres accepts TCP before it can run queries, so the first acquire against a freshly revived or crash-recovering host no longer fails. Any other connect error still fails at once.
- When a revived postmaster exits before it is ready, the error includes the path to its log file.
- `parseHostStatus` also returns `dataDir` / `socketDir` / `logsDir` when autopg reports them (additive).

## 0.2.0-beta.0

First beta cut (npm `beta` dist-tag). Host attach is TCP-only; Vite `cedarPgDev` panel + `cedarpg status` / `studio`.

### Breaking

- `parseHostStatus` / `discoverHost` (public) report the **registered** port and no longer throw on a stopped host (`running: false`). Supervisor `status` strings (pm2 `online` vs systemd-user / launchd) are not a liveness model. Probe TCP, or use `acquire`, before connecting.

### Added

- Vite plugin `cedarPgDev()` (`@cedarjs/pg/vite-plus`): status panel on listen + shortcuts `d` (status) / `s` (Prisma or Drizzle Studio). Shortcuts bind only on Vite 8 / vite-plus (optional peer `vite >= 8`); Vite 7 / Cedar skips them so the listen panel still prints. Studio is detected from the Vite app root (or `cwd`) up to the worktree
- CLI: `cedarpg status` (human + `--json`) and `cedarpg studio` (`--prisma` / `--drizzle`). Studio runs attached (inherit stdio, exit code) and detects from cwd up to the worktree. `--json` prints the `DevStatus` object
- Public `resolveDevStatus` for scripting

### Fixed

- Attach liveness is a TCP accept, never `autopg status` alone: `cedarpg acquire` no longer connects to a registered-but-stopped host (`ECONNREFUSED 127.0.0.1:25432`).
- Local host recovery brings the **registered** autopg host back: `autopg restart`, then `autopg install` if still no listener, then attach once TCP accepts (error names the registered port and lists what was tried). `restart` exiting 0 is not treated as live. Same port and `~/.autopg/data`; cedar-pg never starts a second local Postgres.
- `CEDAR_PG_EPHEMERAL_HOST=0` now has one meaning: never start an owned postmaster (even under `CI=true`) — local autopg host only, or fail.
- Ephemeral host: start detached `autopg postmaster` only. Do not run `install --no-pm2` (that rewrites `~/.autopg/admin.json` and fails with `supervisor mismatch` next to a local pm2 install).
- `@cedarjs/pg/vite-plus` no longer statically imports `vite`, so the optional peer can be absent (smoke / Nx-only installs)
- TEMPLATE `cloneWorkerDatabase`: process-scope memo on `globalThis` so Jest `setupFiles` (module reload per file) reuses one clone per worker instead of hitting `database already exists` on `_c_<workerId>`. Default name is still `JEST_WORKER_ID` / `VITEST_POOL_ID` / pid — unique `pid_time` names are `cloneFromTemplate` when `name` is omitted.
- Ephemeral host: prune stale `/dev/shm/cedar-pg-*` / `pgserve-*` / `PostgreSQL.*` when the recipe port is dead; append remount/cleanup hints on Disk quota / ENOSPC / 53100

### Changed

- npm dist-tag is now `beta` (was `alpha`). Install with `@cedarjs/pg@beta`.

### Docs

- Nx canonical shape (`db:ready` + `cedarpg run --force`), Jest `CEDAR_PG_FORCE` + `setupFilesAfterEnv`, Yarn ignore-scripts CI recipe, `/dev/shm` troubleshooting, README install/`@beta` caveats

### Contracts (unchanged)

- CLI binary: `cedarpg`; npm: `@cedarjs/pg`
- State dirs: `.cedarpg` (worktree) and `~/.cedarpg/registry`
- Password salt: opaque `cedar-pg\\0` + `roleName` (scheme v2)

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
