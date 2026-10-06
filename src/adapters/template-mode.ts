import { dispose, acquireIfNeeded, type AcquireIfNeededResult } from "../core/lifecycle.ts";
import { cloneFromTemplateIfNeeded, markTemplate } from "../core/template.ts";

export type TemplateMigrateContext = {
  databaseUrl: string;
  adminUrl: string;
  databaseName: string;
  roleName: string;
};

export type TemplateMigrateFn = (ctx: TemplateMigrateContext) => void | Promise<void>;

export type SetupTemplateModeOptions = {
  root?: string;
  /** App-owned migrate; runs once, then `markTemplate`. Required. */
  migrate: TemplateMigrateFn;
  setEnv?: boolean;
};

/**
 * Runner orchestration: fresh acquire → migrate → markTemplate.
 * The acquire is `fresh`: leftovers a crashed earlier run left under this
 * worktree's test role (TEMPLATE, worker clones) are dropped first, so migrate
 * always starts from an empty database and no consumer pre-cleanup is needed.
 * After acquire succeeds, migrate + markTemplate are all-or-nothing: any failure
 * best-effort disposes the lease so Vitest (no separate teardown) does not leak.
 * Programmatic apps that do not need a migrate hook should call core
 * `acquire` + `markTemplate` + `cloneFromTemplate` + `dispose` instead.
 */
export async function setupTemplateMode(
  options: SetupTemplateModeOptions,
): Promise<AcquireIfNeededResult> {
  const result = await acquireIfNeeded({
    root: options.root,
    mode: "test",
    fresh: true,
    setEnv: options.setEnv !== false,
  });
  if (result.status !== "acquired") return result;

  try {
    await options.migrate({
      databaseUrl: result.databaseUrl,
      adminUrl: result.adminUrl,
      databaseName: result.databaseName,
      roleName: result.roleName,
    });
    await markTemplate({
      root: result.root,
      mode: "test",
      adminUrl: result.adminUrl,
    });
  } catch (err) {
    try {
      await dispose({ root: result.root, mode: "test" });
    } catch {
      // best-effort: leave lease for dispose/gc retry
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `template setup failed after acquire; cleaned up lease DB (${result.databaseName}). ` +
        `Fix the error and re-run: ${detail}`,
      { cause: err },
    );
  }

  return result;
}

export type CloneWorkerDatabaseOptions = {
  root?: string;
  /** Clone suffix; defaults to JEST_WORKER_ID / VITEST_POOL_ID / pid. */
  name?: string;
};

/**
 * One clone per worker (`<template>_c_<JEST_WORKER_ID | VITEST_POOL_ID | pid>`),
 * shared by every test file that worker runs. Call it once per test file
 * (`beforeAll` in `setupFilesAfterEnv`, or a Vitest `setupFiles` module).
 *
 * The first file creates the clone. Later files reuse it (`reuse: true`): the
 * database itself is the source of truth, so this holds even though Jest gives
 * each file a fresh `globalThis` and module registry. Clones left over from a
 * crashed earlier run cannot leak in — `setupTemplateMode` drops them first.
 *
 * Uses `cloneFromTemplateIfNeeded` (same skip policy as `acquireIfNeeded`) with `setEnv: true`.
 */
export async function cloneWorkerDatabase(options: CloneWorkerDatabaseOptions = {}): Promise<void> {
  const name =
    options.name ?? process.env.JEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? String(process.pid);
  await cloneFromTemplateIfNeeded({
    root: options.root,
    mode: "test",
    name,
    reuse: true,
    setEnv: true,
  });
}
