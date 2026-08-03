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

### Host startup (CI ephemeral)

By default cedar-pg **attaches** to a live autopg host (`autopg status`). If none is live it runs bare `autopg install` (pm2) — fine for local machines, hostile to GitHub Actions (no pm2) and slower than RAM-backed CI.

In CI, cedar-pg starts an **opinionated ephemeral host** automatically when `CI=true` (or when forced). Callers just use `ensure` — no host options bag:

```ts
import { ensure } from "@cedarjs/pg";

// CI=true → install --no-pm2 --no-ui + detached postmaster (--ram on Linux /dev/shm)
const { databaseUrl } = await ensure({ mode: "test" });
```

| Signal                      | Effect                                               |
| --------------------------- | ---------------------------------------------------- |
| `CEDAR_PG_EPHEMERAL_HOST=1` | Force owned ephemeral host                           |
| `CEDAR_PG_EPHEMERAL_HOST=0` | Force local attach / pm2 install (even if `CI=true`) |
| unset + `CI=true`           | Auto ephemeral                                       |
| otherwise                   | Local: attach if live, else bare `autopg install`    |

Ephemeral recipe (not configurable via cedar-pg):

- `autopg install --no-pm2 --no-ui --data DIR`
- detached `autopg postmaster` with `--socket-dir DIR`
- Linux when `/dev/shm` exists → `--ram` and `DIR=/dev/shm/cedar-pg-<uid>`
- otherwise → disk `DIR` under the OS temp dir (still owned, no pm2)

If a host is already live, cedar-pg attaches and does not start another. The **CI job owns** ephemeral postmaster lifetime (runner teardown / `/dev/shm`); there is no cedar-pg host dispose API.

### CI caching (GitHub Actions)

Pin the autopg version (this package’s `postinstall` already pins a release tag — currently `v3.0.7`). Cache the binary tree so cold jobs skip the ~155MB download:

```yaml
- uses: actions/cache@v4
  with:
    path: |
      ~/.local/share/autopg
      ~/.local/bin/autopg
    key: autopg-v3.0.7-${{ runner.os }}
- run: echo "$HOME/.local/bin" >> "$GITHUB_PATH"
```

Set `CEDAR_PG_INSTALL_AUTOPG=1` so `postinstall` still fetches autopg when the cache misses under `CI=true`. Or bake the binary into the image.

## Env

| Var                           | Meaning                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `AUTOPG_BIN`                  | Path to autopg                                                     |
| `CEDAR_PG=0`                  | Disable auto-ensure in adapters                                    |
| `TEST_DATABASE_URL`           | Escape hatch: skip ensure for external DBs (not `cpg_*` / `file:`) |
| `CEDAR_PG_FORCE=1`            | Ignore external-URL escape hatch                                   |
| `CEDAR_PG_EPHEMERAL_HOST`     | `1` force / `0` disable ephemeral host (auto when `CI=true`)       |
| `CEDAR_PG_REGISTRY_DIR`       | Override global lease registry (for `gc`)                          |
| `CEDAR_PG_SKIP_POSTINSTALL=1` | Skip autopg install hook                                           |
| `CEDAR_PG_INSTALL_AUTOPG=1`   | Force autopg install in CI                                         |

## Alpha caveats

- Public API may change before `0.1.0`.
- End-to-end Postgres flows assume a working local `autopg` host; CI unit tests do not start Postgres.
- State lives in product-owned `.cedarpg` (worktree + `~/.cedarpg/registry`), not under autopg's `~/.autopg/` or a generic `.pg`.
- Password salt (`cedar-pg\\0`, scheme v1) is an opaque crypto constant; bump the scheme id to change it.
