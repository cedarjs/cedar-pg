import { ensureIfNeeded, type EnsureResult } from "../core/lifecycle.ts";
import type { DbMode } from "../core/naming.ts";

export type EnsureTaskContext = Pick<
  EnsureResult,
  "databaseUrl" | "adminUrl" | "databaseName" | "roleName" | "root" | "mode" | "port"
>;

export type CreateEnsureTaskOptions = {
  mode: DbMode;
  root?: string;
  /** Ignore external-URL escape hatch (`CEDAR_PG_FORCE=1` also works). */
  force?: boolean;
  setEnv?: boolean;
  /** App-owned migrate/seed after a successful ensure. */
  afterEnsure?: (ctx: EnsureTaskContext) => void | Promise<void>;
};

/** ensure → optional afterEnsure (db:ready / migrate compose). */
export function createEnsureTask(options: CreateEnsureTaskOptions): () => Promise<void> {
  return async () => {
    const result = await ensureIfNeeded({
      root: options.root,
      mode: options.mode,
      setEnv: options.setEnv !== false,
      force: options.force,
    });
    if (result.status !== "ensured" || !options.afterEnsure) return;
    await options.afterEnsure({
      databaseUrl: result.databaseUrl,
      adminUrl: result.adminUrl,
      databaseName: result.databaseName,
      roleName: result.roleName,
      root: result.root,
      mode: result.mode,
      port: result.port,
    });
  };
}
