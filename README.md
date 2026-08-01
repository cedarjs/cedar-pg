# cedar-pg

Worktree-isolated local Postgres for **Vite+**, **Nx**, and **CedarJS** — powered by the [autopg](https://github.com/automagik-dev/autopg) host singleton.

- **1 database per git worktree** (readable names in `\l`)
- **dev** DBs persist across restarts; **test** DBs drop on dispose
- First-class **Vite+ Task** + **Nx** adapters
- Ships with a `postinstall` that ensures the `autopg` binary when missing

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

Host autopg singleton (installed automatically by `postinstall`, or manually):

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/autopg/main/install.sh | bash
```

## Develop this package (Vite+)

```bash
vp install
vp check
vp test
vp pack          # → dist/ (dts + esm + cjs)
```

## Local consume (no npm publish)

```bash
# in cedar-pg
vp pack

# in your app / Cedar
yarn add cedar-pg@file:../cedar-pg
# or: npm pack && yarn add ./cedar-pg-0.1.0.tgz
```

## CLI

```bash
cedar-pg ensure --mode=dev
cedar-pg ensure --mode=test --print-env
cedar-pg dispose --mode=test
cedar-pg print-url --mode=dev
cedar-pg gc   # drop DBs whose worktree root is gone (uses ~/.cedar-pg/registry)
```

## Vite+ consumer adapter

```ts
// vite.config.ts
import { defineConfig } from "vite-plus";
import { cedarPgTasks } from "cedar-pg/vite-plus";

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
import { ensure, dispose } from "cedar-pg";

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
