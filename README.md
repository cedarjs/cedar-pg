# cedar-pg

Worktree-isolated local Postgres for **Vite+**, **Nx**, and **CedarJS** — powered by [autopg](https://github.com/automagik-dev/autopg).

Published on npm as **`@cedarjs/pg`**.

> **Alpha** (`0.1.0-alpha.0`): APIs may change. Install with the `alpha` dist-tag.

## What you get (via autopg)

Under the hood you get an **embedded PostgreSQL server with true concurrent connections** — native PostgreSQL 18 (not WASM), real process forking, no connection locks. It just works: **no credentials needed**, **zero config**, and **auto-provisioned databases** on first use. Any client works (`psql`, `node-postgres`, Prisma, Drizzle, TypeORM).

### Development & testing

| Use case                | What you get                               |
| ----------------------- | ------------------------------------------ |
| **Local development**   | PostgreSQL without Docker                  |
| **Integration testing** | Real PostgreSQL, not mocks                 |
| **CI/CD pipelines**     | Fresh databases per test run               |
| **E2E testing**         | Isolated database for Playwright / Cypress |

## What cedar-pg adds

**cedar-pg** sits on that autopg host and gives each **git worktree** its own database + role, with readable names, leases, and teardown — so parallel checkouts don’t fight over one shared DB:

- **1 database per git worktree** (visible in `\l` as `cpg_…`)
- **dev** DBs persist across restarts; **test** DBs drop on dispose
- First-class **Vite+ Task** + **Nx** / Vitest / Jest adapters
- `postinstall` ensures the pinned `autopg` binary when missing

| Layer        | Responsibility                                                      |
| ------------ | ------------------------------------------------------------------- |
| **autopg**   | Embedded Postgres host — concurrent, zero-config, auto-provision    |
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
Both the install script and binary are pinned to a release tag (currently `v3.0.7`); bump the pin in `scripts/postinstall.js` to upgrade:

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/autopg/v3.0.7/install.sh \
  | AUTOPG_VERSION=v3.0.7 bash
```

Typical flow: `autopg daemon` (or your usual host install) once per machine → `cedarpg ensure` per worktree → connect with the printed `DATABASE_URL`.

## Develop this package (Vite+)

```bash
vp install
vp check
vp test
vp pack          # → dist/ (dts + esm + cjs)
vp run smoke     # build → npm-pack tarball → install + resolve exports
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

## Programmatic API

```ts
import { ensure, dispose } from "@cedarjs/pg";

const { databaseUrl, databaseName, dispose: drop } = await ensure({ mode: "test" });
// … tests …
await drop();
```

## Env

| Var                           | Meaning                                                             |
| ----------------------------- | ------------------------------------------------------------------- |
| `AUTOPG_BIN`                  | Path to autopg                                                      |
| `CEDAR_PG=0`                  | Disable auto-ensure in adapters                                     |
| `TEST_DATABASE_URL`           | Escape hatch — skip ensure for external DBs (not `cpg_*` / `file:`) |
| `CEDAR_PG_FORCE=1`            | Ignore external-URL escape hatch                                    |
| `CEDAR_PG_REGISTRY_DIR`       | Override global lease registry (for `gc`)                           |
| `CEDAR_PG_SKIP_POSTINSTALL=1` | Skip autopg install hook                                            |
| `CEDAR_PG_INSTALL_AUTOPG=1`   | Force autopg install in CI                                          |

## Alpha caveats

- Public API may change before `0.1.0`.
- End-to-end Postgres flows assume a working local `autopg` host; CI unit tests do not start Postgres.
- State lives in product-owned `.cedarpg` (worktree + `~/.cedarpg/registry`) — not under autopg's `~/.autopg/`, not a generic `.pg`.
- Password salt (`cedar-pg\\0`, scheme v1) is an opaque crypto constant; bump the scheme id to change it.
