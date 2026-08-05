export { acquire, acquireIfNeeded, dispose, gc, urlFromLease } from "./core/lifecycle.ts";
export type {
  AcquireOptions,
  AcquireResult,
  AcquireIfNeededOptions,
  AcquireIfNeededResult,
  DisposeOptions,
  DisposeResult,
} from "./core/lifecycle.ts";

export { markTemplate, cloneFromTemplate, cloneFromTemplateIfNeeded } from "./core/template.ts";
export type {
  MarkTemplateOptions,
  CloneFromTemplateOptions,
  CloneFromTemplateIfNeededOptions,
  CloneFromTemplateIfNeededResult,
  CloneResult,
} from "./core/template.ts";

export { resolveWorktreeIdentity, resolveRoot } from "./core/worktree.ts";
export type { WorktreeIdentity } from "./core/worktree.ts";

export { buildDatabaseName, buildRoleName, buildCloneDatabaseName } from "./core/naming.ts";
export type { DbMode } from "./core/naming.ts";

/** Worktree state dir name (`.cedarpg`). Prefer this over hardcoding in framework hosts. */
export { STATE_DIRNAME, CLI_NAME } from "./core/constants.ts";

/** Worker-side loader for `.cedarpg/test.env` (also `@cedarjs/pg/test-env`). */
export { loadTestEnv } from "./adapters/load-test-env.ts";
export type { LoadTestEnvOptions } from "./adapters/load-test-env.ts";

/** Dev loader for `.cedarpg/dev.env` (also `@cedarjs/pg/dev-env`). */
export { loadDevEnv } from "./adapters/load-dev-env.ts";
export type { LoadDevEnvOptions } from "./adapters/load-dev-env.ts";

export { createAcquireTask } from "./adapters/acquire-task.ts";
export type { CreateAcquireTaskOptions, AcquireTaskContext } from "./adapters/acquire-task.ts";

/** Read-only lease inspection (mutate/forget APIs are internal; drop-then-forget only). */
export { parseLease, readLease, isOrphanLease, envFilePath } from "./core/lease.ts";
export type { Lease } from "./core/lease.ts";

export {
  resolveAcquireSkip,
  applyDatabaseUrlEnv,
  isCedarPgManagedUrl,
  isExternalDatabaseEscapeHatch,
} from "./core/policy.ts";
export type { AcquireSkip, ResolveAcquireSkipInput } from "./core/policy.ts";

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
export type { AutopgDiscovery } from "./providers/autopg.ts";
