export { ensure, dispose, gc } from "./core/lifecycle.ts";
export type { EnsureOptions, EnsureResult, DisposeOptions } from "./core/lifecycle.ts";

export { resolveWorktreeIdentity, resolveRoot, fingerprintFor } from "./core/worktree.ts";
export type { WorktreeIdentity } from "./core/worktree.ts";

export { buildDatabaseName, buildRoleName } from "./core/naming.ts";
export type { DbMode } from "./core/naming.ts";

export {
  resolveAutopgBin,
  requireAutopgBin,
  ensureHostRunning,
  discoverHost,
  INSTALL_HINT,
} from "./providers/autopg.ts";
