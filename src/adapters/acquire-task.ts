import { acquireIfNeeded, type AcquireResult } from "../core/lifecycle.ts";
import type { DbMode } from "../core/naming.ts";

export type AcquireTaskContext = Pick<
  AcquireResult,
  "databaseUrl" | "adminUrl" | "databaseName" | "roleName" | "root" | "mode" | "port"
>;

export type CreateAcquireTaskOptions = {
  mode: DbMode;
  root?: string;
  /** Ignore external-URL escape hatch (`CEDAR_PG_FORCE=1` also works). */
  force?: boolean;
  setEnv?: boolean;
  /** App-owned migrate/seed after a successful acquire. */
  afterAcquire?: (ctx: AcquireTaskContext) => void | Promise<void>;
};

/** Run acquireIfNeeded, then optional afterAcquire (migrate / db:ready). */
export function createAcquireTask(options: CreateAcquireTaskOptions): () => Promise<void> {
  return async () => {
    const result = await acquireIfNeeded({
      root: options.root,
      mode: options.mode,
      setEnv: options.setEnv !== false,
      force: options.force,
    });
    if (result.status !== "acquired" || !options.afterAcquire) return;
    await options.afterAcquire({
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
