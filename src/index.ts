export {
  ensure,
  ensureIfNeeded,
  markTemplate,
  cloneFromTemplate,
  dispose,
  gc,
  urlFromLease,
} from "./core/lifecycle.ts";
export type {
  EnsureOptions,
  EnsureResult,
  EnsureIfNeededOptions,
  EnsureIfNeededResult,
  MarkTemplateOptions,
  CloneFromTemplateOptions,
  CloneResult,
  DisposeOptions,
  DisposeResult,
} from "./core/lifecycle.ts";

export { resolveWorktreeIdentity, resolveRoot } from "./core/worktree.ts";
export type { WorktreeIdentity } from "./core/worktree.ts";

export { buildDatabaseName, buildRoleName, buildCloneDatabaseName } from "./core/naming.ts";
export type { DbMode } from "./core/naming.ts";

/** Worktree state dir name (`.cedarpg`). Prefer this over hardcoding in framework hosts. */
export { STATE_DIRNAME, CLI_NAME } from "./core/constants.ts";

/** Worker-side loader for `.cedarpg/test.env` (also shipped as `@cedarjs/pg/test-env`). */
export { loadTestEnv } from "./adapters/load-test-env.ts";

/** Read-only lease inspection (mutate/forget APIs are internal; drop-then-forget only). */
export { parseLease, readLease, isOrphanLease } from "./core/lease.ts";
export type { Lease } from "./core/lease.ts";

export {
  resolveEnsureSkip,
  applyDatabaseUrlEnv,
  isCedarPgManagedUrl,
  isExternalDatabaseEscapeHatch,
} from "./core/policy.ts";
export type { EnsureSkip, ResolveEnsureSkipInput } from "./core/policy.ts";

export {
  resolveAutopgBin,
  requireAutopgBin,
  discoverHost,
  parseHostStatus,
  buildDatabaseUrl,
  rolePasswordFor,
  ROLE_PASSWORD_SCHEME,
  INSTALL_HINT,
} from "./providers/autopg.ts";
export { ensureHostRunning } from "./providers/host.ts";
export type { AutopgDiscovery } from "./providers/autopg.ts";
