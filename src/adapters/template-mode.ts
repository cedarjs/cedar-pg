import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import {
  cloneFromTemplate,
  dispose,
  ensureIfNeeded,
  markTemplate,
  type EnsureIfNeededResult,
} from "../core/lifecycle.ts";
import { resolveEnsureSkip } from "../core/policy.ts";

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
 * Global setup for migrate-once + TEMPLATE clones:
 * ensure host/lease → migrate → markTemplate.
 *
 * For migrate-yourself without a hook, use `ensure` + `markTemplate` from `@cedarjs/pg`
 * instead of this helper.
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

  process.env.CEDAR_PG_ADMIN_URL = result.adminUrl;

  await options.migrate({
    databaseUrl: result.databaseUrl,
    adminUrl: result.adminUrl,
    databaseName: result.databaseName,
    roleName: result.roleName,
  });
  await markTemplate({
    root: result.root,
    mode: "test",
    databaseName: result.databaseName,
    adminUrl: result.adminUrl,
  });

  return result;
}

export type SetupTemplateWorkerOptions = {
  root?: string;
  /** Clone suffix; defaults to JEST_WORKER_ID / VITEST_POOL_ID / pid. */
  name?: string;
};

/**
 * Per-worker clone → sets DATABASE_URL / TEST_DATABASE_URL.
 * Prefer {@link ensureWorkerDatabase} from setupFilesAfterEnv (process-once).
 */
export async function setupTemplateWorker(options: SetupTemplateWorkerOptions = {}): Promise<void> {
  const skip = resolveEnsureSkip();
  if (skip.skip) {
    if (skip.reason === "external-url") {
      process.env.DATABASE_URL = skip.databaseUrl;
      process.env.TEST_DATABASE_URL = skip.databaseUrl;
    }
    return;
  }

  const name =
    options.name ?? process.env.JEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? String(process.pid);

  await cloneFromTemplate({
    root: options.root,
    mode: "test",
    name,
    setEnv: true,
  });
}

let workerOnce: Promise<void> | undefined;

/**
 * Process-once {@link setupTemplateWorker} using JEST_WORKER_ID / VITEST_POOL_ID / pid.
 * For custom `name`/`root`, call `setupTemplateWorker` once yourself.
 */
export function ensureWorkerDatabase(): Promise<void> {
  workerOnce ??= setupTemplateWorker().catch((err) => {
    workerOnce = undefined;
    throw err;
  });
  return workerOnce;
}

/** Drop TEMPLATE + all role-owned clones; forget lease. */
export async function teardownTemplateMode(options: { root?: string } = {}): Promise<void> {
  await dispose({ root: options.root, mode: "test" });
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
  if (typeof fn !== "function") {
    throw new Error("CEDAR_PG_MIGRATE must export migrate() or a default function");
  }
  return fn as TemplateMigrateFn;
}

function toImportUrl(spec: string): string {
  if (spec.startsWith("file:") || spec.includes("://")) return spec;
  if (spec.startsWith(".") || isAbsolute(spec)) {
    return pathToFileURL(resolve(process.cwd(), spec)).href;
  }
  return spec;
}
