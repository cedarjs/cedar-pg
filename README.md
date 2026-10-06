# cedar-pg

Worktree-isolated local Postgres for Vite+, Nx, and CedarJS. The host is [autopg](https://github.com/automagik-dev/autopg) (embedded PostgreSQL 18). cedar-pg creates one database and role per git worktree so parallel checkouts do not share a DB.

Published as `@cedarjs/pg`. CLI: `cedarpg`. Beta (`0.2.0-beta.1`, `beta` dist-tag). Public APIs may still change.

| Layer    | Owns                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| autopg   | Postgres process, port, concurrent connections                                    |
| cedar-pg | Per-worktree `CREATE DATABASE` and role, lease files, `DATABASE_URL`, dispose, GC |

## Install

Node `>=24`.

```bash
npm install -D @cedarjs/pg@beta
# pnpm add -D @cedarjs/pg@beta
# yarn add -D @cedarjs/pg@beta
```

`postinstall` installs the pinned autopg binary when it is missing. The pin is `scripts/autopg-version`. To bump autopg, change that file.

To install the host by hand (local, non-CI; upstream `install.sh` may use pm2):

```bash
VER=$(tr -d '[:space:]' < scripts/autopg-version)
curl -fsSL "https://raw.githubusercontent.com/automagik-dev/autopg/${VER}/install.sh" \
  | AUTOPG_VERSION="$VER" bash
```

Once per machine, run the host (`autopg daemon`, or your usual install). Then per worktree:

```bash
cedarpg acquire --mode=dev
```

Connect with the printed `DATABASE_URL`.

From another checkout of this repo, pack first, then depend on the build:

```bash
vp pack
# in the app: yarn add @cedarjs/pg@file:../cedar-pg
# or install the tarball vp pack writes (name includes the version in package.json)
```

Every push to `main` and every PR also builds a preview on [pkg.pr.new](https://pkg.pr.new) (not the npm registry):

```bash
pnpm add -D https://pkg.pr.new/@cedarjs/pg@<commit-sha-or-pr-number>
```

## Acquire a database

`dev` databases persist across restarts. `test` databases drop on `dispose`.

Names look like this (visible in `psql` `\l`):

```text
cpg_<repo>_<worktree>_<mode>_<pathHash8>
```

Worktree state lives in `.cedarpg`. Import `STATE_DIRNAME` instead of hardcoding that string. `gc` uses `~/.cedarpg/registry`.

## CLI

```bash
cedarpg acquire --mode=dev
cedarpg acquire --mode=test --print-env
cedarpg run --mode=dev -- yarn tsx scripts/apiServer/dev.ts
cedarpg run --mode=test -- vitest run
cedarpg run --attach --mode=dev -- node dist/server.js   # existing lease only, no DDL
cedarpg dispose --mode=test
cedarpg print-url --mode=dev
cedarpg status --mode=dev
cedarpg studio --mode=dev          # Prisma or Drizzle Studio (--prisma / --drizzle)
cedarpg gc                         # drop DBs whose worktree root is gone
```

`status` and `studio` are read-only. They do not acquire. `studio` walks from cwd up to the worktree.

`cedarpg run` acquires (idempotent role and database DDL), then execs the command. The child always gets `DATABASE_URL` from the lease. In test mode it also gets `TEST_DATABASE_URL`. `--force` only sets `CEDAR_PG_FORCE=1`, so nested adapters do not treat an ambient URL as an escape hatch.

`cedarpg run --attach` skips the acquire. It reads the lease a prior `acquire` / `run` wrote, sets the same child env, and execs. It never runs DDL and never starts or revives the host. It fails (nonzero, before the child starts) when there is no lease or nothing is listening on the leased port.

If two targets run `cedarpg acquire` or plain `cedarpg run` on the same worktree, role and database DDL can race. Acquire once, then wrap children with `run --attach`. Any number of those can run concurrently.

## Vite+

```ts
// vite.config.ts
import { defineConfig } from "vite-plus";
import { cedarPgTasks, cedarPgDev } from "@cedarjs/pg/vite-plus";

export default defineConfig({
  plugins: [cedarPgDev()],
  run: {
    tasks: {
      ...cedarPgTasks(),
      test: {
        command: "vp test",
        dependsOn: ["db:acquire-test"],
        env: ["DATABASE_URL", "TEST_DATABASE_URL"],
      },
      dev: {
        command: "vp dev",
        dependsOn: ["db:acquire"],
        env: ["DATABASE_URL"],
      },
    },
  },
});
```

`cedarPgDev()` does not acquire. Keep `dependsOn: ["db:acquire"]`. On listen it prints a status panel (TTY, non-CI). Vite CLI shortcuts (`key` then Enter; also listed under `h`):

| Key | Action                                                                 |
| --- | ---------------------------------------------------------------------- |
| `d` | Reprint status (name, port, `DATABASE_URL`, env file)                  |
| `s` | Open Prisma Studio or Drizzle Kit Studio with the lease `DATABASE_URL` |

Options: `cedarPgDev({ mode, root, cwd, studio: "prisma" | "drizzle" | false })`. Studio walks from `cwd` (default Vite `config.root`) up to the worktree, so an Nx `apps/...` package is found without moving the lease. `prisma` wins when both ORMs sit in the same package.

Shortcuts bind on Vite 8 and vite-plus. Vite 7 and Cedar print the listen panel only. Use `cedarpg status` and `cedarpg studio` for Nx and other non-Vite hosts.

## Nx

Nx `dependsOn` does not forward env from an acquire task into dependents. Vite+ `env: [...]` does. Canonical shape:

1. One `db:ready` that acquires and migrates: `createAcquireTask` (below), or `cedarpg run --mode=dev --force -- <migrate cmd>`. This is the only target that runs DDL.
2. Wrap API, dev, worker, and e2e children with attach-only `cedarpg run --attach --mode=dev -- <cmd>`. They read the lease `db:ready` wrote and never acquire, so `api:dev` and workers can start concurrently without racing role/DB DDL.

Instead of wrapping a child, it can call `loadDevEnv({ overwrite: true })` or `import "@cedarjs/pg/dev-env"`. Pointing Nx `envFile` at `.cedarpg/<mode>.env` still loses to an ambient `.env` unless you overwrite.

```ts
import {
  cedarPgAttachCommand,
  cedarPgNxTargets,
  cedarPgRunCommand,
  relativeEnvFile,
} from "@cedarjs/pg/nx";

cedarPgNxTargets();
// { "db:acquire": { command: "cedarpg acquire --mode=dev", cache: false }, ... }

cedarPgRunCommand("dev", "prisma migrate deploy");
// "cedarpg run --mode=dev -- prisma migrate deploy"   (db:ready: acquire + exec)

cedarPgAttachCommand("dev", "yarn tsx scripts/apiServer/dev.ts");
// "cedarpg run --attach --mode=dev -- yarn tsx scripts/apiServer/dev.ts"   (children)

relativeEnvFile("dev"); // ".cedarpg/dev.env"
```

```json
{
  "targets": {
    "db:ready": { "command": "tsx tools/db-ready.ts", "cache": false },
    "dev": {
      "dependsOn": ["db:ready"],
      "command": "cedarpg run --attach --mode=dev -- yarn tsx scripts/apiServer/dev.ts"
    },
    "workers": {
      "dependsOn": ["db:ready"],
      "command": "cedarpg run --attach --mode=dev -- yarn tsx scripts/workers.ts"
    },
    "serve": {
      "dependsOn": ["db:ready"],
      "command": "cedarpg run --attach --mode=dev -- node dist/server.js"
    }
  }
}
```

Migrate hook for `db:ready` (same compose shape as Jest `createGlobalSetup`):

```ts
// tools/db-ready.ts
import { createAcquireTask } from "@cedarjs/pg";

await createAcquireTask({
  mode: "dev",
  // Need this when .env already has DATABASE_URL
  force: true,
  afterAcquire: async ({ databaseUrl }) => {
    // prisma migrate deploy, drizzle push, ...
  },
})();
```

Absolute path helper: `envFilePath(root, mode)`.

## Vitest and Jest

Stock `@cedarjs/pg/vitest` and `@cedarjs/pg/jest` only acquire and dispose. One shared test DB. They do not migrate, and they do not clone per worker. For migrate-once plus clones, see [TEMPLATE clones](#template-clones).

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["@cedarjs/pg/vitest"],
  },
});
```

Vitest runs `globalSetup` in the main process, then workers inherit `process.env`. Add `setupFiles: ["@cedarjs/pg/test-env"]` only if your pool does not inherit env.

```js
// jest.config.cjs
module.exports = {
  globalSetup: require.resolve("@cedarjs/pg/jest"),
  globalTeardown: require.resolve("@cedarjs/pg/jest-teardown"),
  // Jest globalSetup is a separate process. Workers load DATABASE_URL from .cedarpg/test.env.
  setupFiles: [require.resolve("@cedarjs/pg/test-env")],
};
```

`loadTestEnv` and `loadDevEnv` fill undefined keys by default. Pass `{ overwrite: true }` (or import `@cedarjs/pg/dev-env`) when a local `.env` URL should lose to cedar-pg. That is not the same as `CEDAR_PG_FORCE` or `{ force: true }` (external-URL escape hatch).

## CedarJS and custom globalSetup

If the runner already owns `globalSetup` (Prisma push or migrate after acquire), do not replace it with `@cedarjs/pg/jest`. Compose:

1. In `globalSetup`, call `acquireIfNeeded` when opted in, then migrate.
2. Add `setupFiles: [require.resolve("@cedarjs/pg/test-env")]` so Jest workers see `DATABASE_URL`.
3. In `globalTeardown`, call `dispose({ mode: "test", root })`.

```ts
import { acquireIfNeeded } from "@cedarjs/pg";

if (process.env.CEDAR_PG === "1" || process.env.CEDAR_PG === "true") {
  await acquireIfNeeded({
    root: projectRoot, // e.g. getPaths().base
    mode: "test",
    setEnv: true, // this process (prisma). Workers use @cedarjs/pg/test-env.
    url: process.env.TEST_DATABASE_URL,
    force: process.env.CEDAR_PG_FORCE === "1",
    disabled: false, // framework opt-in. Stock adapters use CEDAR_PG=0 opt-out.
  });
}
```

## TEMPLATE clones

Migrate stays app-owned via `createGlobalSetup({ migrate })`. The adapter then marks TEMPLATE and clones per worker.

Point `globalSetup` at a local module that calls `createGlobalSetup`. String-resolving the package entry without a migrate hook throws.

Each setup starts clean. Before migrate, `createGlobalSetup` drops every database owned by this worktree's test role: a TEMPLATE and worker clones left behind by a crashed or killed run, even if its lease file is gone. `migrate` therefore always runs against an empty database, and you do not need your own pre-cleanup. Only this worktree's `cpg_*_test_*` role is touched, never other databases on the shared host. Core API: `acquire({ mode: "test", fresh: true })`.

`cloneWorkerDatabase()` gives each worker one clone, `<template>_c_<JEST_WORKER_ID | VITEST_POOL_ID | pid>`, shared by every test file that worker runs. The first file creates it. Later files find it in Postgres and reuse it. Nothing is cached in memory, so this holds under Jest's per-file `globalThis` and module registry. Files in the same worker share data in that clone, as they would with any per-worker database. If the clone name exists but belongs to a different role, the call fails with a clear error rather than reusing it.

### Jest

```js
// jest.cedar-global.cjs
const { createGlobalSetup } = require("@cedarjs/pg/jest/template");
module.exports = createGlobalSetup({
  migrate: async ({ databaseUrl }) => {
    // prisma migrate reset, drizzle push
  },
});

// jest.config.cjs
// When .env has a real TEST_DATABASE_URL, set FORCE once here so it
// inherits into globalSetup and workers (dotenv will not override existing keys).
process.env.CEDAR_PG_FORCE = "1";

module.exports = {
  globalSetup: "<rootDir>/jest.cedar-global.cjs",
  globalTeardown: require.resolve("@cedarjs/pg/jest-teardown"),
  // Runs once per test file; every file in a worker reuses that worker's clone.
  setupFilesAfterEnv: ["<rootDir>/jest.cedar-worker.cjs"],
};

// jest.cedar-worker.cjs
const { cloneWorkerDatabase } = require("@cedarjs/pg/jest/template");
beforeAll(() => cloneWorkerDatabase());
```

### Vitest

```ts
// vitest.cedar-global.ts
import { createGlobalSetup } from "@cedarjs/pg/vitest/template";
export default createGlobalSetup({
  migrate: async ({ databaseUrl }) => {
    // migrate once
  },
});

// vitest.config.ts
export default defineConfig({
  test: {
    globalSetup: ["./vitest.cedar-global.ts"],
    setupFiles: ["./vitest.cedar-worker.ts"],
  },
});

// vitest.cedar-worker.ts
import { cloneWorkerDatabase } from "@cedarjs/pg/vitest/template";
await cloneWorkerDatabase();
```

### Core API

No runner adapters.

```ts
import { acquire, markTemplate, cloneFromTemplate, dispose } from "@cedarjs/pg";

const acquired = await acquire({ mode: "test" });
await migrate({ databaseUrl: acquired.databaseUrl, adminUrl: acquired.adminUrl });
await markTemplate({ root: acquired.root, mode: "test", adminUrl: acquired.adminUrl });
const worker = await cloneFromTemplate({
  root: acquired.root,
  mode: "test",
  name: "1",
  setEnv: true,
});
await worker.dropClone(); // optional: drop one clone only
await dispose({ root: acquired.root, mode: "test" }); // TEMPLATE + all clones + role
```

`acquire` returns `adminUrl` for migrate hooks and privileged DDL. `markTemplate` and `cloneFromTemplate` accept it, or rediscover the host when it is omitted. `cloneFromTemplate` uses the admin connection (`CREATE DATABASE ... TEMPLATE`). Test roles stay `LOGIN`-only.

`setEnv` defaults to false on `cloneFromTemplate`. It defaults to true on `cloneFromTemplateIfNeeded` (same as `acquireIfNeeded`). Worker adapters call `cloneFromTemplateIfNeeded` via `cloneWorkerDatabase`, with `reuse: true`.

An explicit `name` that already exists fails with `database already exists` unless you pass `reuse: true`. Then a clone owned by the lease role is kept as is, and the result has `reused: true`.

`dispose` is role-scoped suite teardown, not `dropClone`. It unsets `IS_TEMPLATE` and drops every database owned by the lease role.

## Host and CI

`acquire` attaches when TCP accepts on the port from `autopg status --json`. Registration is not liveness. An installed-but-stopped host still reports a port.

When nothing is listening, cedar-pg brings up the registered local host. It runs `autopg restart`, then (if still dark) detached `autopg postmaster` on the registered port and `~/.autopg/data`. `restart` exiting 0 is not a listener (`respawned daemon` with no TCP is the pm2-less no-op). It does not run `autopg install` on an already-registered host (that path wants pm2). `install` is only for a never-registered machine. Same port, same data dir — not a second Postgres. The data dir and socket dir come from `autopg status --json`. They are never guessed: if autopg reports no `dataDir`, revive is skipped. If a live `postmaster.pid` already owns the data dir (pm2 still recovering, or a concurrent acquire), cedar-pg waits for that postmaster instead of starting a competitor. The revived postmaster has no supervisor and lives until reboot or crash. Its output is appended to `cedarpg-postmaster.log` in autopg's `logsDir` (`~/.autopg/logs`). If revive still produces no listener, `acquire` fails with what it tried.

Callers use `acquire` (and `adminUrl`). There is no public host-options object. Ephemeral behavior is env-driven.

```ts
import { acquire } from "@cedarjs/pg";

// CI=true: detached postmaster (--ram on Linux /dev/shm). Does not rewrite ~/.autopg.
const { databaseUrl } = await acquire({ mode: "test" });
```

| Signal                      | Effect (attach always wins when something is listening)                                      |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `CEDAR_PG_EPHEMERAL_HOST=1` | Ephemeral owned postmaster on 55432                                                          |
| `CEDAR_PG_EPHEMERAL_HOST=0` | Never start the ephemeral 55432 postmaster (even in CI). Local registered host only, or fail |
| unset and `CI=true`         | Ephemeral                                                                                    |
| unset                       | Local: `autopg restart`, then registered `postmaster` if still dark, then fail               |

Ephemeral recipe (not configurable via cedar-pg):

- Detached `autopg postmaster --port 55432 --socket-dir DIR --data DIR`
- Does not run `autopg install` (that rewrites `~/.autopg/admin.json` and conflicts with a local pm2 host)
- Linux when `/dev/shm` exists: also `--ram` and `DIR=/dev/shm/cedar-pg-<uid>`
- Otherwise: disk `DIR` under the OS temp dir
- Ready when TCP accepts on the recipe port
- Before cold-start, if the recipe port is not live, cedar-pg prunes leftover `/dev/shm/cedar-pg-*`, `pgserve-*`, and `PostgreSQL.*` (OOM-killed runs filling tmpfs). Safe on isolated CI VMs. On shared self-hosted runners another job's leftovers could match those globs.

If TCP already accepts on the discovered autopg port, or in ephemeral mode on 55432, cedar-pg attaches and does not start another. The CI job owns ephemeral postmaster lifetime (runner teardown, `/dev/shm`). There is no cedar-pg host dispose API.

Cloud VMs often ship `/dev/shm` at about 64MB, too small for `--ram`. Remount before tests if needed (`sudo mount -o remount,size=6G /dev/shm`). See [Troubleshooting](#troubleshooting).

### GitHub Actions

Prefer the composite action (cache plus attested binary install, no pm2). Version defaults to this repo's `scripts/autopg-version`. Inputs and outputs: [`.github/actions/setup-autopg`](.github/actions/setup-autopg/README.md).

```yaml
- uses: actions/checkout@v6
# In cedar-pg:
- uses: ./.github/actions/setup-autopg
# From another repo (pin to a tag when publishing the action):
# - uses: cedarjs/cedar-pg/.github/actions/setup-autopg@main
```

The action runs `scripts/ci-install-autopg.sh`. For published-package consumers under `CI=true` without the Action, set `CEDAR_PG_INSTALL_AUTOPG=1` so `postinstall` runs that script (not upstream `install.sh`). That flag is not enough when the package manager disables lifecycle scripts (`--ignore-scripts`, `YARN_ENABLE_SCRIPTS=false`). Prefer the Action, or bake the binary into the image.

Yarn Berry or ignore-scripts, when you cannot use the Action. Requires a real `node_modules` tree (`nodeLinker: node-modules` or pnpm). Default Yarn PnP has no `node_modules/@cedarjs/pg/...` path. Resolve via `yarn node` or `require.resolve`, or prefer the Action.

```yaml
- name: Ensure autopg binary
  run: |
    set -euo pipefail
    echo "${HOME}/.local/bin" >> "${GITHUB_PATH}"
    export PATH="${HOME}/.local/bin:${PATH}"
    bash node_modules/@cedarjs/pg/scripts/ci-install-autopg.sh
  env:
    GH_TOKEN: ${{ github.token }}
```

## Environment variables

| Var                                    | Meaning                                                                                                                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTOPG_BIN`                           | Path to the autopg binary                                                                                                                                                                            |
| `AUTOPG_PG_USER`, `AUTOPG_PG_PASSWORD` | Autopg superuser for admin URL (default user `postgres`, password `postgres`)                                                                                                                        |
| `CEDAR_PG=0`                           | Disable auto-acquire in adapters                                                                                                                                                                     |
| `TEST_DATABASE_URL`                    | Default escape hatch for `acquireIfNeeded`. Skip acquire for a real external DB (not `cpg_*`, `file:`, or `{...}` or `<...>` placeholders). Callers may pass `url` (`DATABASE_URL` is common in dev) |
| `CEDAR_PG_FORCE=1`                     | Ignore the external-URL escape hatch (adapters, `cedarpg acquire --force`, `cedarpg run --force`)                                                                                                    |
| `CEDAR_PG_EPHEMERAL_HOST`              | `1` owned postmaster. `0` never own one (even in CI). Unset and `CI=true` means ephemeral                                                                                                            |
| `CEDAR_PG_REGISTRY_DIR`                | Override the global lease registry (for `gc`)                                                                                                                                                        |
| `CEDAR_PG_SKIP_POSTINSTALL=1`          | Skip the autopg install hook                                                                                                                                                                         |
| `CEDAR_PG_INSTALL_AUTOPG=1`            | Under `CI=true`, run binary-only `ci-install-autopg.sh` from postinstall                                                                                                                             |

`force`, `overwrite`, and `run` are different knobs. Do not collapse them.

## Programmatic API

```ts
import { acquire, loadDevEnv } from "@cedarjs/pg";

const { databaseUrl, adminUrl, databaseName, dispose } = await acquire({ mode: "test" });
await dispose();

loadDevEnv({ overwrite: true }); // override .env DATABASE_URL from .cedarpg/dev.env
```

Unit tests in this repo do not start Postgres. CI runs `vp run smoke:pg` for Vitest and Jest adapters against real Postgres (ephemeral cold-start when the runner has no live host; attach wins otherwise).

## Develop this package

Vite+, Node `>=24` (`.node-version`), `pnpm@11`. Contributor rules: [AGENTS.md](AGENTS.md). User-visible API changes: [CHANGELOG.md](CHANGELOG.md).

```bash
vp install
vp check
vp test
vp pack            # dist/ (dts + esm + cjs)
vp run smoke       # pack, then tarball install, then resolve exports
vp run smoke:pg    # pack, then Vitest and Jest adapters against real ephemeral Postgres
```

## Troubleshooting

| Symptom                                                                                 | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ECONNREFUSED 127.0.0.1:25432` on `cedarpg acquire`                                     | autopg is registered but not listening. cedar-pg attaches only after TCP accepts. It runs `autopg restart`, then detached `autopg postmaster` on the registered port/data if still dark — including when pm2 is missing and `restart` exits 0 ("respawned daemon"). A revived postmaster logs to `~/.autopg/logs/cedarpg-postmaster.log`. `status=stopped` with `runtime.live=true` is healthy once TCP accepts; cedar-pg will not `install` pm2. If revive fails, the error lists what was tried. |
| `database already exists: ..._c_<workerId>` in Jest                                     | Upgrade `@cedarjs/pg`. Older releases cached the clone on `globalThis`, which Jest resets for every test file. `cloneWorkerDatabase` now reuses the worker's clone from Postgres (`reuse: true`), and template setup drops crashed-run leftovers first. If the error says `owned by <other role>`, a database outside this worktree's lease has that name: drop it or pass another `name`.                                                                                                         |
| Acquire skipped. Tests hit shared or stale Postgres                                     | A real `.env` `TEST_DATABASE_URL` (or a `url` the caller passed) trips the escape hatch. Set `CEDAR_PG_FORCE=1` once in `jest.config.js`, or `force: true`, or `cedarpg run --force`.                                                                                                                                                                                                                                                                                                              |
| `Disk quota exceeded` / `No space left on device` / Postgres `53100` on ephemeral start | Enlarge `/dev/shm` (`sudo mount -o remount,size=6G /dev/shm`). On isolated runners only: `rm -rf /dev/shm/cedar-pg-* /dev/shm/pgserve-* /dev/shm/PostgreSQL.*`. Cold-start also prunes these when the recipe port is dead.                                                                                                                                                                                                                                                                         |
| `autopg: command not found` in CI with Yarn `YARN_ENABLE_SCRIPTS=false`                 | `CEDAR_PG_INSTALL_AUTOPG=1` is not enough when lifecycle scripts are off. With `nodeLinker: node-modules`, run `bash node_modules/@cedarjs/pg/scripts/ci-install-autopg.sh` and put `~/.local/bin` on `PATH` (or use `setup-autopg`). PnP: resolve the script path via Yarn, or prefer the Action.                                                                                                                                                                                                 |
| Nx child still uses `.env` `DATABASE_URL`                                               | `dependsOn` does not forward acquire env. Wrap with `cedarpg run --attach --mode=dev -- <cmd>`, or `loadDevEnv({ overwrite: true })`.                                                                                                                                                                                                                                                                                                                                                              |
| Role or DB errors under parallel Nx targets                                             | Children are running plain `cedarpg run` (or `acquire`), so each one runs DDL. Keep the acquire in one `db:ready`, and switch the children to `cedarpg run --attach`.                                                                                                                                                                                                                                                                                                                              |
| `no dev lease ...; attach never acquires` from `cedarpg run --attach`                   | Nothing has acquired this worktree yet. Make the target `dependsOn` your `db:ready` (or run `cedarpg acquire --mode=dev`). On `nothing is listening`, re-run `db:ready` / `acquire` to bring the host back; attach never starts it.                                                                                                                                                                                                                                                                |
