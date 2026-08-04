import { mkdirSync, writeFileSync } from "node:fs";
import { buildCloneDatabaseName, buildDatabaseName, buildRoleName, type DbMode } from "./naming.ts";
import {
  envPath,
  forgetLease,
  isOrphanLease,
  leaseDir,
  listRegistryLeases,
  readLease,
  writeLease,
  type Lease,
} from "./lease.ts";
import { applyDatabaseUrlEnv, resolveEnsureSkip, type ResolveEnsureSkipInput } from "./policy.ts";
import { resolveWorktreeIdentity } from "./worktree.ts";
import {
  buildDatabaseUrl,
  cloneDatabaseFromTemplate,
  dropDatabase,
  dropDatabasesOwnedByRole,
  ensureDatabase,
  setDatabaseIsTemplate,
} from "../providers/autopg.ts";
import { ensureHostRunning } from "../providers/host.ts";

function writeEnvFile(root: string, mode: DbMode, databaseUrl: string): void {
  mkdirSync(leaseDir(root), { recursive: true, mode: 0o700 });
  let body = `DATABASE_URL=${databaseUrl}\n`;
  if (mode === "test") body += `TEST_DATABASE_URL=${databaseUrl}\n`;
  writeFileSync(envPath(root, mode), body, { mode: 0o600 });
}

export function urlFromLease(lease: Lease): string {
  return buildDatabaseUrl({
    port: lease.port,
    databaseName: lease.databaseName,
    roleName: lease.roleName,
  });
}

/**
 * DROP every DB owned by the lease role (TEMPLATE + clones), then forget lease.
 * Provider owns ordering (clones before leased datname) on one admin connection.
 */
async function dropThenForget(lease: Lease, adminUrl: string): Promise<string[]> {
  const dropped = await dropDatabasesOwnedByRole({
    adminUrl,
    roleName: lease.roleName,
    preferLast: lease.databaseName,
  });
  forgetLease(lease);
  return dropped;
}

export type EnsureOptions = {
  root?: string;
  mode: DbMode;
  /** Inject DATABASE_URL / TEST_DATABASE_URL into process.env (default true). */
  setEnv?: boolean;
};

export type EnsureResult = {
  databaseUrl: string;
  /** Superuser URL for privileged DDL (mark template, CREATE DATABASE … TEMPLATE). */
  adminUrl: string;
  databaseName: string;
  roleName: string;
  repoSlug: string;
  worktreeSlug: string;
  pathHash: string;
  root: string;
  mode: DbMode;
  port: number;
  dispose: () => Promise<void>;
};

/**
 * Ensure a worktree-scoped database exists and return connection info.
 *
 * - `dev`: keep DB across restarts.
 * - `test`: DROP when `dispose()` is awaited (callers / test runners own teardown).
 */
export async function ensure(options: EnsureOptions): Promise<EnsureResult> {
  const identity = resolveWorktreeIdentity(options.root);
  const mode = options.mode;
  const databaseName = buildDatabaseName(identity, mode);
  const roleName = buildRoleName(databaseName);

  const host = await ensureHostRunning();
  await ensureDatabase({
    adminUrl: host.adminUrl,
    databaseName,
    roleName,
  });

  const databaseUrl = buildDatabaseUrl({
    port: host.port,
    databaseName,
    roleName,
  });

  const lease: Lease = {
    schemaVersion: 1,
    mode,
    root: identity.root,
    repoSlug: identity.repoSlug,
    worktreeSlug: identity.worktreeSlug,
    pathHash: identity.pathHash,
    databaseName,
    roleName,
    port: host.port,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  writeLease(lease);
  writeEnvFile(identity.root, mode, databaseUrl);

  if (options.setEnv !== false) {
    applyDatabaseUrlEnv(databaseUrl, { mode });
  }

  const disposeFn = async () => {
    await dispose({ root: identity.root, mode });
  };

  return {
    databaseUrl,
    adminUrl: host.adminUrl,
    databaseName,
    roleName,
    repoSlug: identity.repoSlug,
    worktreeSlug: identity.worktreeSlug,
    pathHash: identity.pathHash,
    root: identity.root,
    mode,
    port: host.port,
    dispose: disposeFn,
  };
}

export type EnsureIfNeededOptions = EnsureOptions & ResolveEnsureSkipInput;

export type EnsureIfNeededResult =
  | { status: "skipped"; reason: "disabled" }
  | { status: "skipped"; reason: "external-url"; databaseUrl: string }
  | ({ status: "ensured" } & EnsureResult);

/**
 * Resolve skip policy then ensure. Single entry for hosts (Cedar CLI, Jest, Vitest).
 * On external-url skip, applies DATABASE_URL / TEST_DATABASE_URL when `setEnv` is not false.
 */
export async function ensureIfNeeded(
  options: EnsureIfNeededOptions,
): Promise<EnsureIfNeededResult> {
  const skip = resolveEnsureSkip({
    url: options.url,
    force: options.force,
    disabled: options.disabled,
  });
  if (skip.skip) {
    if (skip.reason === "external-url") {
      if (options.setEnv !== false) {
        applyDatabaseUrlEnv(skip.databaseUrl, { mode: options.mode });
      }
      return { status: "skipped", reason: "external-url", databaseUrl: skip.databaseUrl };
    }
    return { status: "skipped", reason: "disabled" };
  }

  const result = await ensure({
    root: options.root,
    mode: options.mode,
    setEnv: options.setEnv,
  });
  return { status: "ensured", ...result };
}

async function resolveAdminUrl(adminUrl?: string): Promise<string> {
  return adminUrl ?? (await ensureHostRunning()).adminUrl;
}

export type MarkTemplateOptions = {
  root?: string;
  mode: DbMode;
  /** Superuser URL from `ensure`; when omitted, discovers/starts the host. */
  adminUrl?: string;
};

/**
 * After migrations, mark the leased DB as a PostgreSQL TEMPLATE so workers can clone it.
 * Requires a lease from `ensure` (no datname override).
 */
export async function markTemplate(
  options: MarkTemplateOptions,
): Promise<{ databaseName: string; adminUrl: string }> {
  const identity = resolveWorktreeIdentity(options.root);
  const mode = options.mode;
  const lease = readLease(identity.root, mode);
  if (!lease) {
    throw new Error(`no ${mode} lease; run ensure before markTemplate`);
  }
  const adminUrl = await resolveAdminUrl(options.adminUrl);
  await setDatabaseIsTemplate({
    adminUrl,
    databaseName: lease.databaseName,
    isTemplate: true,
  });
  return { databaseName: lease.databaseName, adminUrl };
}

export type CloneFromTemplateOptions = {
  root?: string;
  mode: DbMode;
  /** Superuser URL from `ensure`; when omitted, discovers/starts the host. */
  adminUrl?: string;
  /**
   * Suffix for the clone datname (e.g. Jest worker id).
   * Defaults to `<pid>_<base36 time>`.
   */
  name?: string;
  /**
   * Inject DATABASE_URL / TEST_DATABASE_URL for this clone (default false).
   * Worker adapters pass true; programmatic callers opt in.
   */
  setEnv?: boolean;
};

export type CloneResult = {
  databaseUrl: string;
  adminUrl: string;
  databaseName: string;
  roleName: string;
  templateName: string;
  port: number;
  /**
   * DROP this clone only (leaves TEMPLATE + role if still owned elsewhere).
   * Not suite teardown — use role-scoped `dispose` for that.
   */
  dropClone: () => Promise<void>;
};

/**
 * Clone the leased TEMPLATE database via admin (`CREATE DATABASE … TEMPLATE`).
 * Reuses the template role so `databaseUrl` passwords stay valid (scheme v2).
 * Provider rejects when the leased DB is not marked TEMPLATE.
 * Port comes from the lease; admin URL is passed through or rediscovered.
 */
export async function cloneFromTemplate(options: CloneFromTemplateOptions): Promise<CloneResult> {
  const identity = resolveWorktreeIdentity(options.root);
  const mode = options.mode;
  const lease = readLease(identity.root, mode);
  if (!lease) {
    throw new Error(`no ${mode} lease; run ensure + markTemplate before cloneFromTemplate`);
  }

  const adminUrl = await resolveAdminUrl(options.adminUrl);
  const suffix = options.name ?? `${process.pid}_${Date.now().toString(36)}`;
  const databaseName = buildCloneDatabaseName(lease.databaseName, suffix);

  await cloneDatabaseFromTemplate({
    adminUrl,
    templateName: lease.databaseName,
    databaseName,
    roleName: lease.roleName,
  });

  const databaseUrl = buildDatabaseUrl({
    port: lease.port,
    databaseName,
    roleName: lease.roleName,
  });

  if (options.setEnv) {
    applyDatabaseUrlEnv(databaseUrl, { mode });
  }

  const roleName = lease.roleName;

  return {
    databaseUrl,
    adminUrl,
    databaseName,
    roleName,
    templateName: lease.databaseName,
    port: lease.port,
    dropClone: async () => {
      await dropDatabase({ adminUrl, databaseName, roleName });
    },
  };
}

export type CloneFromTemplateIfNeededOptions = CloneFromTemplateOptions & ResolveEnsureSkipInput;

export type CloneFromTemplateIfNeededResult =
  | { status: "skipped"; reason: "disabled" }
  | { status: "skipped"; reason: "external-url"; databaseUrl: string }
  | ({ status: "cloned" } & CloneResult);

/**
 * Resolve skip policy then clone. Host entry for worker adapters (same skip
 * semantics as `ensureIfNeeded`). On external-url skip, applies DATABASE_URL /
 * TEST_DATABASE_URL when `setEnv` is not false.
 */
export async function cloneFromTemplateIfNeeded(
  options: CloneFromTemplateIfNeededOptions,
): Promise<CloneFromTemplateIfNeededResult> {
  const skip = resolveEnsureSkip({
    url: options.url,
    force: options.force,
    disabled: options.disabled,
  });
  if (skip.skip) {
    if (skip.reason === "external-url") {
      if (options.setEnv !== false) {
        applyDatabaseUrlEnv(skip.databaseUrl, { mode: options.mode });
      }
      return { status: "skipped", reason: "external-url", databaseUrl: skip.databaseUrl };
    }
    return { status: "skipped", reason: "disabled" };
  }

  const result = await cloneFromTemplate(options);
  return { status: "cloned", ...result };
}

export type DisposeOptions = {
  root?: string;
  mode?: DbMode;
};

export type DisposeResult =
  | { dropped: true; databaseName: string; droppedDatabases: string[] }
  | { dropped: false; reason: "no-lease" | "host-unavailable" };

/**
 * Role-scoped suite teardown: DROP every database owned by the lease role
 * (TEMPLATE + clones), then DROP ROLE and forget the lease. Unsets `IS_TEMPLATE`
 * as needed. This is not per-clone cleanup — use `CloneResult.dropClone` for that.
 * No-ops without a valid lease; never invents a DROP target beyond role ownership.
 * If the host is unavailable, leaves the lease so dispose/gc can retry.
 */
export async function dispose(options: DisposeOptions = {}): Promise<DisposeResult> {
  const identity = resolveWorktreeIdentity(options.root);
  const mode = options.mode ?? "test";
  const lease = readLease(identity.root, mode);
  if (!lease) return { dropped: false, reason: "no-lease" };

  let host;
  try {
    host = await ensureHostRunning();
  } catch {
    // Keep lease + registry so a later dispose/gc can still find the DB.
    return { dropped: false, reason: "host-unavailable" };
  }

  const droppedDatabases = await dropThenForget(lease, host.adminUrl);
  return {
    dropped: true,
    databaseName: lease.databaseName,
    droppedDatabases,
  };
}

/**
 * Drop databases whose registered worktree root no longer exists on disk.
 * Registry entries are removed only after a successful DROP (owned DBs + lease DB).
 */
export async function gc(): Promise<{
  dropped: string[];
}> {
  const dropped: string[] = [];
  const orphans = listRegistryLeases().filter(isOrphanLease);
  if (orphans.length === 0) return { dropped };

  let host;
  try {
    host = await ensureHostRunning();
  } catch {
    return { dropped };
  }

  for (const lease of orphans) {
    try {
      const names = await dropThenForget(lease, host.adminUrl);
      dropped.push(...names);
    } catch {
      // Keep registry entry for retry
    }
  }
  return { dropped };
}
