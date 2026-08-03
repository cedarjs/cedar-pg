export { ensure, ensureIfNeeded, dispose, gc, urlFromLease } from "./core/lifecycle.ts";
export type {
  EnsureOptions,
  EnsureResult,
  EnsureIfNeededOptions,
  EnsureIfNeededResult,
  DisposeOptions,
  DisposeResult,
} from "./core/lifecycle.ts";

export { resolveWorktreeIdentity, resolveRoot } from "./core/worktree.ts";
export type { WorktreeIdentity } from "./core/worktree.ts";

export { buildDatabaseName, buildRoleName } from "./core/naming.ts";
export type { DbMode } from "./core/naming.ts";

/** Read-only lease inspection (mutate/forget APIs are internal; drop-then-forget only). */
export { parseLease, readLease, isOrphanLease } from "./core/lease.ts";
export type { Lease } from "./core/lease.ts";

export {
  resolveEnsureSkip,
  isCedarPgManagedUrl,
  isExternalDatabaseEscapeHatch,
} from "./core/policy.ts";
export type { EnsureSkip, ResolveEnsureSkipInput } from "./core/policy.ts";

export {
  resolveAutopgBin,
  requireAutopgBin,
  ensureHostRunning,
  discoverHost,
  parseHostStatus,
  buildDatabaseUrl,
  rolePasswordFor,
  ROLE_PASSWORD_SCHEME,
  INSTALL_HINT,
} from "./providers/autopg.ts";
export type { AutopgDiscovery } from "./providers/autopg.ts";
