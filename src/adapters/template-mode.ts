import { randomBytes } from "node:crypto";
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
  /**
   * Clone suffix. Prefer omitting this: the default is unique per module load
   * (`<worker|w>_<pid>_<base36 time>_<entropy>`) so Jest `setupFiles` (module
   * reload per file) does not collide on `CREATE DATABASE …_c_<workerId>`.
   * Unnamed calls reuse one generated name so process-once memo stays stable
   * (`setupFilesAfterEnv` + `beforeAll`, or Vitest `setupFiles` with top-level await).
   */
  name?: string;
};

let workerOnce: Promise<void> | undefined;
let workerOnceKey: string | undefined;
/** Retained default for unnamed calls within one module load. */
let retainedDefaultName: string | undefined;

/** Unique clone suffix; exported for tests. */
export function defaultCloneWorkerName(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
  now: number = Date.now(),
  entropy: string = randomBytes(3).toString("hex"),
): string {
  const worker = env.JEST_WORKER_ID ?? env.VITEST_POOL_ID ?? "w";
  return `${worker}_${pid}_${now.toString(36)}_${entropy}`;
}

function resolveWorkerName(options: CloneWorkerDatabaseOptions): string {
  if (options.name !== undefined) return options.name;
  retainedDefaultName ??= defaultCloneWorkerName();
  return retainedDefaultName;
}

function workerOptionsKey(root: string | undefined, name: string): string {
  return `${root ?? ""}\0${name}`;
}

/**
 * Process-once clone (unique default name per module load; see {@link defaultCloneWorkerName}).
 * Uses `cloneFromTemplateIfNeeded` (same skip policy as `acquireIfNeeded`) with `setEnv: true`.
 * First call wins for `root`/`name`; conflicting later calls throw.
 *
 * Prefer `setupFilesAfterEnv` + `beforeAll` (Jest) or a once-loaded Vitest setup file
 * so the memo sticks. Plain Jest `setupFiles` reloads the module per file — unique
 * default names avoid "database already exists"; you still get one clone per file.
 */
export function cloneWorkerDatabase(options: CloneWorkerDatabaseOptions = {}): Promise<void> {
  const name = resolveWorkerName(options);
  const key = workerOptionsKey(options.root, name);
  if (workerOnce) {
    if (workerOnceKey !== key) {
      throw new Error(
        `cloneWorkerDatabase already started with different root/name ` +
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
    retainedDefaultName = undefined;
    throw err;
  });
  return workerOnce;
}
