# cedar-pg

Worktree-isolated local Postgres for Vite+, Nx, and CedarJS. The host is [autopg](https://github.com/automagik-dev/autopg) (embedded PostgreSQL 18). cedar-pg creates one database and role per git worktree so parallel checkouts do not share a DB.

Published as `@cedarjs/pg`. CLI: `cedarpg`. Beta (`0.2.0-beta.0`, `beta` dist-tag). Public APIs may still change.

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
cedarpg dispose --mode=test
cedarpg print-url --mode=dev
cedarpg status --mode=dev
cedarpg studio --mode=dev          # Prisma or Drizzle Studio (--prisma / --drizzle)
cedarpg gc                         # drop DBs whose worktree root is gone
```

`status` and `studio` are read-only. They do not acquire. `studio` walks from cwd up to the worktree.

`cedarpg run` acquires or attaches the lease, then execs the command. The child always gets `DATABASE_URL` from the lease. In test mode it also gets `TEST_DATABASE_URL`. `--force` only sets `CEDAR_PG_FORCE=1`, so nested adapters do not treat an ambient URL as an escape hatch.

If two targets run `cedarpg acquire` or `cedarpg run` on the same worktree, role and database DDL can race. Use one acquire, then `run` wrappers.

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

1. One `db:ready` (or `createAcquireTask`) that acquires and migrates.
2. Wrap API, dev, and e2e children with `cedarpg run --mode=dev --force -- <cmd>`.

Pointing Nx `envFile` at `.cedarpg/<mode>.env` after acquire still loses to an ambient `.env` unless you also force or overwrite.

```ts
import { cedarPgNxTargets, cedarPgRunCommand, relativeEnvFile } from "@cedarjs/pg/nx";

cedarPgNxTargets();
// { "db:acquire": { command: "cedarpg acquire --mode=dev", cache: false }, ... }

cedarPgRunCommand("dev", "yarn tsx scripts/apiServer/dev.ts");
// "cedarpg run --mode=dev -- yarn tsx scripts/apiServer/dev.ts"

relativeEnvFile("dev"); // ".cedarpg/dev.env"
```

```json
{
  "targets": {
    "db:ready": { "command": "tsx tools/db-ready.ts", "cache": false },
    "dev": {
      "dependsOn": ["db:ready"],
      "command": "cedarpg run --mode=dev --force -- yarn tsx scripts/apiServer/dev.ts"
    },
    "serve": {
      "dependsOn": ["db:ready"],
      "command": "cedarpg run --mode=dev --force -- node dist/server.js"
    }
  }
}
```

Migrate hook (same compose shape as Jest `createGlobalSetup`):

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

If you cannot wrap with `run`, use `loadDevEnv({ overwrite: true })` or `import "@cedarjs/pg/dev-env"`. Absolute path helper: `envFilePath(root, mode)`.

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
  // Prefer setupFilesAfterEnv so you can use beforeAll (Jest globals).
  setupFilesAfterEnv: ["<rootDir>/jest.cedar-worker.cjs"],
};

// jest.cedar-worker.cjs
const { cloneWorkerDatabase } = require("@cedarjs/pg/jest/template");
beforeAll(() => cloneWorkerDatabase());
```

`cloneWorkerDatabase` memos on `globalThis`, so Jest `setupFiles` (module reload per file) still shares one clone per worker.

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

`setEnv` defaults to false on `cloneFromTemplate`. It defaults to true on `cloneFromTemplateIfNeeded` (same as `acquireIfNeeded`). Worker adapters call `cloneFromTemplateIfNeeded` via `cloneWorkerDatabase`.

`dispose` is role-scoped suite teardown, not `dropClone`. It unsets `IS_TEMPLATE` and drops every database owned by the lease role.

## Host and CI

`acquire` attaches when TCP accepts on the port from `autopg status --json`. Registration is not liveness. An installed-but-stopped host still reports a port.

When nothing is listening, cedar-pg brings up the registered local host. It runs `autopg restart`, then `autopg install` if the host was never registered. It attaches once TCP accepts. Same port, same `~/.autopg/data`. It does not start a second local Postgres. If neither verb produces a listener, `acquire` fails with what it tried.

Callers use `acquire` (and `adminUrl`). There is no public host-options object. Ephemeral behavior is env-driven.

```ts
import { acquire } from "@cedarjs/pg";

// CI=true: detached postmaster (--ram on Linux /dev/shm). Does not rewrite ~/.autopg.
const { databaseUrl } = await acquire({ mode: "test" });
```

| Signal                      | Effect (attach always wins when something is listening)                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `CEDAR_PG_EPHEMERAL_HOST=1` | Ephemeral owned postmaster on 55432                                           |
| `CEDAR_PG_EPHEMERAL_HOST=0` | Never own a postmaster (even when `CI=true`). Local autopg host only, or fail |
| unset and `CI=true`         | Ephemeral                                                                     |
| unset                       | Local: `autopg restart`, then `autopg install`, then fail                     |

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

| Symptom                                                                                 | Fix                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ECONNREFUSED 127.0.0.1:25432` on `cedarpg acquire`                                     | autopg is registered but not listening. cedar-pg runs `autopg restart` (then `install`) and attaches once TCP accepts. `restart` exiting 0 is not proof. When pm2 is missing it still prints "respawned daemon". If both verbs fail, install pm2 or fix the supervisor (`pm2 logs autopg-server`). |
| `database already exists: ..._c_<workerId>` in Jest                                     | Use current `@cedarjs/pg` (`cloneWorkerDatabase` memos on `globalThis`). Prefer `setupFilesAfterEnv` + `beforeAll`. Avoid passing bare `JEST_WORKER_ID` as an explicit `name`.                                                                                                                     |
| Acquire skipped. Tests hit shared or stale Postgres                                     | A real `.env` `TEST_DATABASE_URL` (or a `url` the caller passed) trips the escape hatch. Set `CEDAR_PG_FORCE=1` once in `jest.config.js`, or `force: true`, or `cedarpg run --force`.                                                                                                              |
| `Disk quota exceeded` / `No space left on device` / Postgres `53100` on ephemeral start | Enlarge `/dev/shm` (`sudo mount -o remount,size=6G /dev/shm`). On isolated runners only: `rm -rf /dev/shm/cedar-pg-* /dev/shm/pgserve-* /dev/shm/PostgreSQL.*`. Cold-start also prunes these when the recipe port is dead.                                                                         |
| `autopg: command not found` in CI with Yarn `YARN_ENABLE_SCRIPTS=false`                 | `CEDAR_PG_INSTALL_AUTOPG=1` is not enough when lifecycle scripts are off. With `nodeLinker: node-modules`, run `bash node_modules/@cedarjs/pg/scripts/ci-install-autopg.sh` and put `~/.local/bin` on `PATH` (or use `setup-autopg`). PnP: resolve the script path via Yarn, or prefer the Action. |
| Nx child still uses `.env` `DATABASE_URL`                                               | `dependsOn` does not forward acquire env. Wrap with `cedarpg run --mode=dev --force -- <cmd>`, or `loadDevEnv({ overwrite: true })`.                                                                                                                                                               |
| Role or DB errors under parallel Nx targets                                             | Do not run concurrent `acquire` or `run` on the same worktree. One `db:ready`, then `run` wrappers.                                                                                                                                                                                                |
