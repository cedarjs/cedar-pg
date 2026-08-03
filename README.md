# cedar-pg

Worktree-isolated local Postgres for **Vite+**, **Nx**, and **CedarJS**, powered by [autopg](https://github.com/automagik-dev/autopg).

Published on npm as **`@cedarjs/pg`**.

> **Alpha** (`0.1.0-alpha.0`): APIs may change. Install with the `alpha` dist-tag.

## What you get (via autopg)

autopg runs embedded PostgreSQL 18 (not WASM) with real concurrent connections. No credentials, zero config, and databases are provisioned on first use. Any client works (`psql`, `node-postgres`, Prisma, Drizzle, TypeORM).

### Development & testing

| Use case                | What you get                               |
| ----------------------- | ------------------------------------------ |
| **Local development**   | PostgreSQL without Docker                  |
| **Integration testing** | Real PostgreSQL, not mocks                 |
| **CI/CD pipelines**     | Fresh databases per test run               |
| **E2E testing**         | Isolated database for Playwright / Cypress |

## What cedar-pg adds

**cedar-pg** gives each **git worktree** its own database and role on that autopg host (readable names, leases, teardown) so parallel checkouts do not share one DB:

- **1 database per git worktree** (visible in `\l` as `cpg_…`)
- **dev** DBs persist across restarts; **test** DBs drop on dispose
- First-class **Vite+ Task** + **Nx** / Vitest / Jest adapters
- `postinstall` ensures the pinned `autopg` binary when missing

| Layer        | Responsibility                                                      |
| ------------ | ------------------------------------------------------------------- |
| **autopg**   | Embedded Postgres host (concurrent, zero-config, auto-provision)    |
| **cedar-pg** | Per-worktree `CREATE DATABASE` / role, `DATABASE_URL`, dispose + GC |

## Install

```bash
npm install -D @cedarjs/pg@alpha
# or: pnpm add -D @cedarjs/pg@alpha
# or: yarn add -D @cedarjs/pg@alpha
```

## Database names (observability)

```text
cpg_<repo>_<worktree>_<mode>_<pathHash8>
```

Examples:

| Name                                | Meaning                    |
| ----------------------------------- | -------------------------- |
| `cpg_cedar_cedar_dev_a1b2c3d4`      | main `cedar` checkout, dev |
| `cpg_cedar_feat_auth_test_e5f67890` | worktree `feat-auth`, test |

## Prerequisites

A running [autopg](https://github.com/automagik-dev/autopg) host (installed automatically by `postinstall`, or manually).
The release pin lives in **`scripts/autopg-version`** (single source of truth for postinstall, CI binary install, and docs). Bump that file to upgrade:

```bash
# local / non-CI (upstream install.sh; may use pm2)
VER=$(tr -d '[:space:]' < scripts/autopg-version)
curl -fsSL "https://raw.githubusercontent.com/automagik-dev/autopg/${VER}/install.sh" \
  | AUTOPG_VERSION="$VER" bash
```

Typical flow: `autopg daemon` (or your usual host install) once per machine → `cedarpg ensure` per worktree → connect with the printed `DATABASE_URL`.

## Develop this package (Vite+)

```bash
vp install
vp check
vp test
vp pack            # → dist/ (dts + esm + cjs)
vp run smoke       # build → npm-pack tarball → install + resolve exports
vp run smoke:pg    # pack → Vitest + Jest adapters against real ephemeral Postgres
```

## Local consume (without npm)

```bash
# in this repo
vp pack

# in your app / Cedar
yarn add @cedarjs/pg@file:../cedar-pg
# or: pnpm pack && yarn add ./cedarjs-pg-0.1.0-alpha.0.tgz
```

## CLI

```bash
cedarpg ensure --mode=dev
cedarpg ensure --mode=test --print-env
cedarpg dispose --mode=test
cedarpg print-url --mode=dev
cedarpg gc   # drop DBs whose worktree root is gone (uses ~/.cedarpg/registry)
```

## Vite+ consumer adapter

```ts
// vite.config.ts
import { defineConfig } from "vite-plus";
import { cedarPgTasks } from "@cedarjs/pg/vite-plus";

export default defineConfig({
  run: {
    tasks: {
      ...cedarPgTasks(),
      test: {
        command: "vp test",
        dependsOn: ["db:ensure-test"],
        env: ["DATABASE_URL", "TEST_DATABASE_URL"],
      },
      dev: {
        command: "vp dev",
        dependsOn: ["db:ensure"],
        env: ["DATABASE_URL"],
      },
    },
  },
});
```

## Vitest / Jest adapters

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["@cedarjs/pg/vitest"],
  },
});
```

```js
// jest.config.cjs — standalone apps
module.exports = {
  globalSetup: require.resolve("@cedarjs/pg/jest"),
  globalTeardown: require.resolve("@cedarjs/pg/jest-teardown"),
  // Jest globalSetup is a separate process — workers load DATABASE_URL from .cedarpg/test.env
  setupFiles: [require.resolve("@cedarjs/pg/test-env")],
};
```

### Framework hosts (CedarJS, custom globalSetup)

If your runner already owns `globalSetup` (e.g. Prisma push/migrate after ensure), **do not** replace it with `@cedarjs/pg/jest`. Compose instead:

1. In your `globalSetup`: call `ensureIfNeeded` when opted in, then run migrations.
2. Add `setupFiles: [require.resolve('@cedarjs/pg/test-env')]` so Jest **workers** see `DATABASE_URL`.
3. In your `globalTeardown`: call `dispose({ mode: 'test', root })`.

```ts
// framework globalSetup (sketch)
import { ensureIfNeeded } from "@cedarjs/pg";

if (process.env.CEDAR_PG === "1" || process.env.CEDAR_PG === "true") {
  await ensureIfNeeded({
    root: projectRoot, // e.g. getPaths().base
    mode: "test",
    setEnv: true, // this process (prisma) — workers use @cedarjs/pg/test-env
    url: process.env.TEST_DATABASE_URL,
    force: process.env.CEDAR_PG_FORCE === "1",
    disabled: false, // framework opt-in; adapters alone use CEDAR_PG=0 opt-out
  });
}
// … prisma db push / migrate …
```

```js
// jest-preset
setupFiles: [require.resolve("@cedarjs/pg/test-env")],
```

Use exported `STATE_DIRNAME` (`.cedarpg`) / `loadTestEnv(root?)` instead of hardcoding the lease dir.

## Programmatic API

```ts
import { ensure, dispose, loadTestEnv, STATE_DIRNAME } from "@cedarjs/pg";

const { databaseUrl, adminUrl, databaseName, dispose: drop } = await ensure({ mode: "test" });
// … tests …
await drop();
```

### Host startup (CI ephemeral)

By default cedar-pg **attaches** to a live autopg host (`autopg status`). If none is live it runs bare `autopg install` (pm2) — fine for local machines, hostile to GitHub Actions (no pm2) and slower than RAM-backed CI.

In CI, cedar-pg starts an **opinionated ephemeral host** automatically when `CI=true` (or when forced). Callers just use `ensure` — no host options bag:

```ts
import { ensure } from "@cedarjs/pg";

// CI=true → install --no-pm2 --no-ui + detached postmaster (--ram on Linux /dev/shm)
const { databaseUrl } = await ensure({ mode: "test" });
```

| Signal                      | Effect                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| `CEDAR_PG_EPHEMERAL_HOST=1` | Prefer ephemeral start when **no** host is live (attach still wins) |
| `CEDAR_PG_EPHEMERAL_HOST=0` | Force local attach / pm2 install (even if `CI=true`)                |
| unset + `CI=true`           | Prefer ephemeral when no host is live                               |
| otherwise                   | Local: attach if live, else bare `autopg install`                   |

Ephemeral recipe (not configurable via cedar-pg):

- `autopg install --no-pm2 --no-ui --port 55432 --data DIR`
- detached `autopg postmaster --port 55432 --socket-dir DIR --data DIR`
- Linux when `/dev/shm` exists → also `--ram` and `DIR=/dev/shm/cedar-pg-<uid>`
- otherwise → disk `DIR` under the OS temp dir (still owned, no pm2)
- Ready when TCP accepts on the recipe port (not merely `autopg status` after install)

If a host is already live, cedar-pg attaches and does not start another. The **CI job owns** ephemeral postmaster lifetime (runner teardown / `/dev/shm`); there is no cedar-pg host dispose API.

### CI setup (GitHub Actions)

Prefer the composite action (cache + attested binary install, no pm2). Version defaults to this repo’s `scripts/autopg-version`:

```yaml
- uses: actions/checkout@v6
# In cedar-pg:
- uses: ./.github/actions/setup-autopg
# From another repo (pin to a tag when publishing the action):
# - uses: cedarjs/cedar-pg/.github/actions/setup-autopg@main
```

See [`.github/actions/setup-autopg`](.github/actions/setup-autopg/README.md) for inputs (`version`, `cache`, `token`) and outputs.

The action runs `scripts/ci-install-autopg.sh` under the hood. For published-package consumers under `CI=true` without the Action, set `CEDAR_PG_INSTALL_AUTOPG=1` so `postinstall` runs that same script (not upstream `install.sh`) — that flag alone is not enough when the package manager disables lifecycle scripts (`--ignore-scripts`, `YARN_ENABLE_SCRIPTS=false`, etc.). Prefer this Action, or bake the binary into the image.

### Migrate-once + TEMPLATE clones (Jest workers)

```ts
import { ensure, markTemplate, cloneFromTemplate, dispose } from "@cedarjs/pg";

const ensured = await ensure({ mode: "test" });
// run migrations once against ensured.databaseUrl (Prisma migrate reset, etc.)
await markTemplate(ensured);

const worker = await cloneFromTemplate({ name: process.env.JEST_WORKER_ID ?? "1" });
// worker.databaseUrl — same role credentials; adminUrl for privileged DDL if needed

await dispose({ mode: "test" }); // drops TEMPLATE + all clones owned by the test role
```

`ensure` returns `adminUrl` so apps do not re-derive `postgresql://postgres:postgres@127.0.0.1:<port>/postgres`.
`cloneFromTemplate` uses the admin connection internally (`CREATE DATABASE … TEMPLATE`); test roles stay `LOGIN`-only.
`dispose` unsets `IS_TEMPLATE` and drops every DB owned by the test role (template + clones).

## Env

| Var                            | Meaning                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `AUTOPG_BIN`                   | Path to autopg                                                                                                |
| `AUTOPG_PG_USER` / `_PASSWORD` | Autopg superuser for admin URL (default `postgres` / `postgres`)                                              |
| `CEDAR_PG=0`                   | Disable auto-ensure in adapters                                                                               |
| `TEST_DATABASE_URL`            | Escape hatch: skip ensure for real external DBs (not `cpg_*` / `file:` / `{…}` / `<…>` template placeholders) |
| `CEDAR_PG_FORCE=1`             | Ignore external-URL escape hatch (use for real external DBs / Jest when you still want ensure)                |
| `CEDAR_PG_EPHEMERAL_HOST`      | `1` force / `0` disable ephemeral host (auto when `CI=true`)                                                  |
| `CEDAR_PG_REGISTRY_DIR`        | Override global lease registry (for `gc`)                                                                     |
| `CEDAR_PG_SKIP_POSTINSTALL=1`  | Skip autopg install hook                                                                                      |
| `CEDAR_PG_INSTALL_AUTOPG=1`    | Under `CI=true`, run binary-only `ci-install-autopg.sh` from postinstall                                      |

## Alpha caveats

- Public API may change before `0.1.0`.
- End-to-end Postgres flows assume a working local `autopg` host; unit tests do not start Postgres.
  CI runs `vp run smoke:pg` for Vitest/Jest adapters against real Postgres
  (ephemeral cold-start when the runner has no live host; attach-wins otherwise).
- State lives in product-owned `.cedarpg` (worktree + `~/.cedarpg/registry`), not under autopg's `~/.autopg/` or a generic `.pg`.
- Role passwords are derived from `roleName` (`cedar-pg\\0` + roleName, scheme v2) so TEMPLATE clones that reuse a role keep working; bump the scheme id to change the derivation.
- Test TEMPLATE flow: `ensure` returns `adminUrl`; `markTemplate` / `cloneFromTemplate` / `dispose` own migrate-once worker isolation (dispose drops role-owned DBs).
