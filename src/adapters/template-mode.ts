import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import {
  cloneFromTemplateIfNeeded,
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

  return result;
}

export type EnsureWorkerDatabaseOptions = {
  root?: string;
  /** Clone suffix; defaults to JEST_WORKER_ID / VITEST_POOL_ID / pid. */
  name?: string;
};

let workerOnce: Promise<void> | undefined;

/**
 * Process-once per-worker clone (JEST_WORKER_ID / VITEST_POOL_ID / pid by default).
 * First call wins for `root`/`name` when using the process-once path.
 */
export function ensureWorkerDatabase(options: EnsureWorkerDatabaseOptions = {}): Promise<void> {
  workerOnce ??= (async () => {
    const name =
      options.name ??
      process.env.JEST_WORKER_ID ??
      process.env.VITEST_POOL_ID ??
      String(process.pid);
    await cloneFromTemplateIfNeeded({
      root: options.root,
      mode: "test",
      name,
      setEnv: true,
    });
  })().catch((err) => {
    workerOnce = undefined;
    throw err;
  });
  return workerOnce;
}

function isMigrateFn(value: unknown): value is TemplateMigrateFn {
  return typeof value === "function";
}

/** Require migrate from `CEDAR_PG_MIGRATE` or throw (default runner hooks). */
export async function requireMigrateFromEnv(): Promise<TemplateMigrateFn> {
  const spec = process.env.CEDAR_PG_MIGRATE?.trim();
  if (!spec) {
    throw new Error(
      "template mode requires a migrate hook: set CEDAR_PG_MIGRATE or use createGlobalSetup({ migrate })",
    );
  }

  const mod = (await import(toImportUrl(spec))) as {
    default?: unknown;
    migrate?: unknown;
  };
  const fn = mod.migrate ?? mod.default;
  if (!isMigrateFn(fn)) {
    throw new Error("CEDAR_PG_MIGRATE must export migrate() or a default function");
  }
  return fn;
}

function toImportUrl(spec: string): string {
  if (spec.startsWith("file:") || spec.includes("://")) return spec;
  if (spec.startsWith(".") || isAbsolute(spec)) {
    return pathToFileURL(resolve(process.cwd(), spec)).href;
  }
  return spec;
}
