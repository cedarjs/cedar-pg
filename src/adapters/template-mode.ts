import {
  cloneFromTemplateIfNeeded,
  dispose,
  ensureIfNeeded,
  markTemplate,
  type EnsureIfNeededResult,
} from "../core/lifecycle.ts";

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
 * Runner orchestration: ensure → migrate → markTemplate.
 * After ensure succeeds, migrate + markTemplate are all-or-nothing: any failure
 * best-effort disposes the lease so Vitest (no separate teardown) does not leak.
 * Programmatic apps that do not need a migrate hook should call core
 * `ensure` + `markTemplate` + `cloneFromTemplate` + `dispose` instead.
 */
export async function setupTemplateMode(
  options: SetupTemplateModeOptions,
): Promise<EnsureIfNeededResult> {
  const result = await ensureIfNeeded({
    root: options.root,
    mode: "test",
    setEnv: options.setEnv !== false,
  });
  if (result.status !== "ensured") return result;

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
      `template setup failed after ensure; cleaned up lease DB (${result.databaseName}). ` +
        `Fix the error and re-run: ${detail}`,
      { cause: err },
    );
  }

  return result;
}

export type EnsureWorkerDatabaseOptions = {
  root?: string;
  /** Clone suffix; defaults to JEST_WORKER_ID / VITEST_POOL_ID / pid. */
  name?: string;
};

let workerOnce: Promise<void> | undefined;
let workerOnceKey: string | undefined;

function resolveWorkerName(options: EnsureWorkerDatabaseOptions): string {
  return (
    options.name ?? process.env.JEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? String(process.pid)
  );
}

function workerOptionsKey(root: string | undefined, name: string): string {
  return `${root ?? ""}\0${name}`;
}

/**
 * Process-once per-worker clone (JEST_WORKER_ID / VITEST_POOL_ID / pid by default).
 * Uses `cloneFromTemplateIfNeeded` (same skip policy as `ensureIfNeeded`) with `setEnv: true`.
 * First call wins for `root`/`name`; conflicting later calls throw.
 */
export function ensureWorkerDatabase(options: EnsureWorkerDatabaseOptions = {}): Promise<void> {
  const name = resolveWorkerName(options);
  const key = workerOptionsKey(options.root, name);
  if (workerOnce) {
    if (workerOnceKey !== key) {
      throw new Error(
        `ensureWorkerDatabase already started with different root/name ` +
          `(first: ${JSON.stringify(workerOnceKey)}, now: ${JSON.stringify(key)})`,
      );
    }
    return workerOnce;
  }
  workerOnceKey = key;
  workerOnce = (async () => {
    await cloneFromTemplateIfNeeded({
      root: options.root,
      mode: "test",
      name,
      setEnv: true,
    });
  })().catch((err) => {
    workerOnce = undefined;
    workerOnceKey = undefined;
    throw err;
  });
  return workerOnce;
}
