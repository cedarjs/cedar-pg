# AGENTS.md

Guidance for coding agents working on **cedar-pg** (`@cedarjs/pg`).

Human-facing docs live in `README.md`. This file is for how to change the code safely.

## What this package is

Worktree-isolated local Postgres for Vite+, Nx, and CedarJS, on top of [autopg](https://github.com/automagik-dev/autopg).

| Layer        | Owns                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------- |
| **autopg**   | Embedded Postgres host (binary, daemon/postmaster, concurrent connections)                        |
| **cedar-pg** | Per-worktree `CREATE DATABASE` / role, lease files, `DATABASE_URL`, dispose + GC, runner adapters |

Mental model: autopg is the host; cedar-pg is the lease + naming + policy layer so parallel git worktrees do not share one DB.

Published npm package: `@cedarjs/pg` (CLI binary: `cedarpg`). Alpha (`0.2.0-alpha.x`, `alpha` dist-tag) — public APIs may still change; treat renames and export surface as intentional product decisions, not drive-by churn.

## Commands

Tooling is **Vite+** (`vp`). Node `>=24` (see `.node-version`). Package manager: `pnpm@11`.

```bash
vp install          # install deps
vp check            # lint + typecheck (type-aware)
vp test             # unit tests (no live Postgres required)
vp pack             # build → dist/ (dts + esm + cjs)
vp run smoke        # pack → tarball → install + resolve exports
vp run smoke:pg     # pack → Vitest + Jest adapters against real ephemeral Postgres
```

CI (`.github/workflows/ci.yml`): `vp check` → `vp test` → `vp run smoke` → `vp run smoke:pg`, with `.github/actions/setup-autopg` for the binary.

Bump autopg via the single pin file `scripts/autopg-version` (postinstall, CI install, docs). Do not scatter version strings.

## Source layout

```text
src/
  core/         # worktree identity, naming, leases, policy, acquire/dispose, TEMPLATE
  providers/    # autopg CLI + SQL; host attach / ephemeral CI start
  adapters/     # Vite+, Nx, Vitest, Jest, env loaders, acquire-task, template orchestration
  cli.ts        # cedarpg CLI
  index.ts      # public @cedarjs/pg surface
tests/          # unit tests (mock / no Postgres unless testing SQL helpers carefully)
scripts/        # postinstall, CI binary install, smoke harnesses
```

Pack entries and npm `exports` are declared in `vite.config.ts` `pack.entry` and `package.json` `exports`. Plan paths stay flat (`./vite-plus`, `./nx`, …) — do not expose `./adapters/…` in the public map. When adding a public entry:

1. Add `src/…` module
2. Register `pack.entry` in `vite.config.ts`
3. Add matching `package.json` `exports` (types + import + require)
4. Re-export from `src/index.ts` only if it belongs on the root API
5. Cover with unit tests and, if adapter-facing, consider `smoke` / `smoke:pg`

## Frozen product contracts

Do not casually change these without a changelog + alpha migration note:

| Contract           | Value                                          | Notes                                                                              |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| CLI name           | `cedarpg`                                      | `CLI_NAME` in `src/core/constants.ts`                                              |
| Worktree state dir | `.cedarpg`                                     | `STATE_DIRNAME` — product-owned, not under `~/.autopg/`                            |
| Global registry    | `~/.cedarpg/registry`                          | Used by `gc` for orphan worktrees                                                  |
| DB name shape      | `cpg_<repo>_<worktree>_<mode>_<pathHash8>`     | `src/core/naming.ts`                                                               |
| Role password      | scheme **v2**: `sha256(cedar-pg\0 + roleName)` | Bump `ROLE_PASSWORD_SCHEME` to rotate; salt is opaque crypto, not a product rename |
| Modes              | `dev` (persist) / `test` (dispose drops)       |                                                                                    |

Export `STATE_DIRNAME` / `CLI_NAME` / `envFilePath` for consumers — never tell frameworks to hardcode `.cedarpg`.

## Layering rules

Keep logic in the canonical layer. Prefer reuse over one-off branches in adapters.

| Concern                                         | Canonical home                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Acquire / dispose / gc                          | `src/core/lifecycle.ts`                                                            |
| Skip policy (`CEDAR_PG=0`, external URL, force) | `src/core/policy.ts` (`resolveAcquireSkip`, `runIfNeeded`, `applyDatabaseUrlEnv`)  |
| TEMPLATE mark / clone                           | `src/core/template.ts`                                                             |
| Lease read/write / registry                     | `src/core/lease.ts`                                                                |
| Host attach vs ephemeral CI start               | `src/providers/host.ts` (internal; `ensureHostRunning` is **not** a public export) |
| SQL / autopg CLI / URLs / role password         | `src/providers/autopg.ts`                                                          |
| Shared Vite+/Nx task strings                    | `src/adapters/tasks.ts` (`cedarPgLifecycleTargets`, `cedarPgRunCommand`)           |
| Runner TEMPLATE orchestration + migrate hook    | `src/adapters/template-mode.ts` → thin Jest/Vitest wrappers                        |

**Adapters should be thin.** They compose core + policy. Do not reimplement skip/env/host logic inside Jest/Vitest/Nx helpers. If both `acquireIfNeeded` and `cloneFromTemplateIfNeeded` need the same gate, extend `runIfNeeded` — do not copy conditionals.

**Migrate stays app-owned.** Stock `@cedarjs/pg/jest` / `vitest` only acquire/dispose. TEMPLATE adapters require `createGlobalSetup({ migrate })`; string-resolving the package entry without a migrate hook must throw.

**Host bootstrap stays internal.** Callers use `acquire` (and `adminUrl`). Do not re-export `ensureHostRunning` or grow a public host-options bag; ephemeral behavior is env-driven (`CI`, `CEDAR_PG_EPHEMERAL_HOST`). Default local acquire may start an owned postmaster after a no-op `autopg install` (stopped pm2); `CEDAR_PG_EPHEMERAL_HOST=0` disables that fallback.

## Env and policy (easy to get wrong)

| Mechanism                                          | Meaning                                                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `CEDAR_PG=0`                                       | Opt-out auto-acquire in adapters                                                                          |
| External `TEST_DATABASE_URL` / `DATABASE_URL`      | Escape hatch → skip acquire (unless managed `cpg_*` / placeholders)                                       |
| `CEDAR_PG_FORCE=1` / `{ force: true }` / `--force` | Ignore external-URL escape hatch                                                                          |
| `loadTestEnv` / `loadDevEnv`                       | Fill **undefined** keys by default; `{ overwrite: true }` or `@cedarjs/pg/dev-env` to beat ambient `.env` |
| `cedarpg run`                                      | Always force-sets child `DATABASE_URL` (Nx `dependsOn` does **not** forward env)                          |

These are different knobs. Do not collapse `force`, `overwrite`, and `run` into one boolean flag scattered across call sites.

Nx canonical consumer shape: one `db:ready` / `createAcquireTask`, then wrap children with `cedarpg run --mode=… --force -- <cmd>`. Never recommend concurrent `acquire`/`run` on the same worktree (DDL races).

## Testing expectations

- **Unit tests** live under `tests/` and must not require a live autopg host.
- **Postgres-backed** confidence is `vp run smoke:pg` (and CI). Prefer extending that harness over inventing ad-hoc live-DB tests in unit suites.
- Prefer testing pure policy/naming/lease parsers with fixtures; mock process/env at the boundary.
- When changing dispose/TEMPLATE/clone semantics, update `tests/lifecycle-dispose.test.ts`, `tests/template-*.test.ts`, and README troubleshooting if symptoms change.

## Packaging checklist

- Published files: `dist/`, `scripts/autopg-version`, `scripts/ci-install-autopg.sh`, `scripts/postinstall.js` (see `package.json` `files`).
- Dual ESM/CJS + dts via `vp pack`; keep default export shapes stable for Jest CJS `require.resolve`.
- `postinstall` must stay safe when scripts are disabled; document Action / `ci-install-autopg.sh` path for Yarn ignore-scripts consumers.
- Changelog: user-visible API, CLI, env, and contract changes under `CHANGELOG.md` Unreleased (or the next alpha section).

---

## Code quality bar (thermo-nuclear)

Apply this bar to every meaningful change. Correct behavior is necessary but not sufficient.

### Ambition: delete complexity

- Prefer a **code-judo** reframing that removes whole branches, helpers, modes, or layers while preserving behavior.
- Do not stop at “a bit cleaner.” If the same idea can be expressed with fewer concepts, push for that.
- Refactors that only relocate complexity without reducing what a reader must hold in their head are not done.

### Structure and spaghetti

- Do **not** bolt feature checks into unrelated shared paths. New conditionals in busy flows are a design smell — move them behind policy, a typed result, or a dedicated module.
- Keep feature-specific orchestration in adapters; keep invariants in `core/` / `providers/`.
- Prefer one canonical helper over near-duplicate skip/env/host logic in multiple adapters.
- Avoid one-off booleans, nullable modes, and “temporary” branches that will become permanent debt.

### File size and modularity

- Do not push a file from under **1000 lines** to over 1000 without a strong structural reason. Decompose first (helpers, focused modules).
- Split by ownership (policy vs SQL vs runner glue), not by dumping “utils.”
- Thin wrappers and identity pass-throughs that add indirection without clarity should be deleted, not polished.

### Types and boundaries

- Prefer explicit typed results (`AcquireSkip`, `RunIfNeededResult`, lease types) over `any` / loose objects / silent fallbacks.
- Question unnecessary optionality and casts — make the invariant explicit at the boundary instead.
- Public exports are a product surface: grow them deliberately; keep internal host/SQL details off `src/index.ts` unless consumers truly need them.

### Orchestration

- Independent work should not be serialized for no reason.
- Related updates that can leave half-applied state (e.g. migrate without `markTemplate`, drop without forget) should stay atomic or document the failure path (see TEMPLATE setup’s best-effort dispose on failure).
- Dispose is **role-scoped** (TEMPLATE + clones + role), not “drop one clone” — `dropClone` vs `dispose` must stay distinct.

### Approval checklist (do not rubber-stamp)

Block or redesign when the change:

1. Preserves incidental complexity when a simpler model is visible
2. Crosses the 1k-line file threshold without decomposition
3. Adds ad-hoc branching that tangles an existing flow
4. Scatters feature checks across shared modules instead of isolating them
5. Adds wrappers, casts, or optional soup that obscure the real contract
6. Duplicates an existing canonical helper or puts logic in the wrong layer
7. Widens the public API / frozen contracts without changelog + clear justification

Good review prompts:

- “Is there a code-judo move that deletes these branches?”
- “Does this belong in `policy` / `lifecycle` / `template-mode` instead of here?”
- “Can we reuse `runIfNeeded` / `cedarPgLifecycleTargets` instead of a bespoke path?”
- “Why is this optional/cast — can the boundary be explicit?”
- “Does this push a file past 1k lines — can we split first?”

## Definition of done

For a typical PR:

1. `vp check` and `vp test` pass locally
2. Packaging or export changes: `vp run smoke`
3. Host/adapter/Postgres behavior changes: `vp run smoke:pg` when feasible
4. README / CHANGELOG updated for user-visible or contract changes
5. Layering and thermo-nuclear checklist above satisfied — not merely “tests green”
