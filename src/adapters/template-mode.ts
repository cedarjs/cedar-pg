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
 * Runner orchestration: acquire → migrate → markTemplate.
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

/** Survives Jest `setupFiles` module reloads (module-scoped `let` does not). */
const CLONE_WORKER_MEMO = Symbol.for("@cedarjs/pg/cloneWorkerDatabase");

type CloneWorkerMemo = {
  promise: Promise<void>;
  key: string;
};

type GlobalWithCloneWorkerMemo = typeof globalThis & {
  [CLONE_WORKER_MEMO]?: CloneWorkerMemo;
};

function readCloneWorkerMemo(): CloneWorkerMemo | undefined {
  return (globalThis as GlobalWithCloneWorkerMemo)[CLONE_WORKER_MEMO];
}

function writeCloneWorkerMemo(memo: CloneWorkerMemo | undefined): void {
  const g = globalThis as GlobalWithCloneWorkerMemo;
  if (memo === undefined) delete g[CLONE_WORKER_MEMO];
  else g[CLONE_WORKER_MEMO] = memo;
}

function resolveWorkerName(options: CloneWorkerDatabaseOptions): string {
  return (
    options.name ?? process.env.JEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? String(process.pid)
  );
}

function workerOptionsKey(root: string | undefined, name: string): string {
  return `${root ?? ""}\0${name}`;
}

/**
 * Process-once per-worker clone (JEST_WORKER_ID / VITEST_POOL_ID / pid by default).
 * Uses `cloneFromTemplateIfNeeded` (same skip policy as `acquireIfNeeded`) with `setEnv: true`.
 * First call wins for `root`/`name`; conflicting later calls throw.
 *
 * Memo lives on `globalThis` so Jest `setupFiles` (module reload per file) still
 * shares one clone per worker. `setupFilesAfterEnv` + `beforeAll` also works.
 */
export function cloneWorkerDatabase(options: CloneWorkerDatabaseOptions = {}): Promise<void> {
  const name = resolveWorkerName(options);
  const key = workerOptionsKey(options.root, name);
  const existing = readCloneWorkerMemo();
  if (existing) {
    if (existing.key !== key) {
      throw new Error(
        `cloneWorkerDatabase already started with different root/name ` +
          `(first: ${JSON.stringify(existing.key)}, now: ${JSON.stringify(key)})`,
      );
    }
    return existing.promise;
  }
  const promise = (async () => {
    await cloneFromTemplateIfNeeded({
      root: options.root,
      mode: "test",
      name,
      setEnv: true,
    });
  })().catch((err) => {
    writeCloneWorkerMemo(undefined);
    throw err;
  });
  writeCloneWorkerMemo({ promise, key });
  return promise;
}
