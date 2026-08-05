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
import { resolveEnsureSkip, type ResolveEnsureSkipInput } from "./policy.ts";
import { resolveWorktreeIdentity } from "./worktree.ts";
import {
  buildDatabaseUrl,
  cloneDatabaseFromTemplate,
  dropDatabase,
  ensureDatabase,
  listDatabasesOwnedByRole,
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
 * Unsets `IS_TEMPLATE` inside each drop. Never forget without successful DROP(s).
 */
async function dropThenForget(lease: Lease, adminUrl: string): Promise<string[]> {
  const owned = await listDatabasesOwnedByRole({
    adminUrl,
    roleName: lease.roleName,
  });
  const ordered = [...owned.filter((name) => name !== lease.databaseName), lease.databaseName];
  const dropped: string[] = [];
  for (const databaseName of ordered) {
    await dropDatabase({
      adminUrl,
      databaseName,
      roleName: lease.roleName,
    });
    dropped.push(databaseName);
  }
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
    process.env.DATABASE_URL = databaseUrl;
    if (mode === "test") {
      process.env.TEST_DATABASE_URL = databaseUrl;
    }
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
 * On external-url skip, sets DATABASE_URL when `setEnv` is not false.
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
        process.env.DATABASE_URL = skip.databaseUrl;
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

export type MarkTemplateOptions = {
  root?: string;
  mode?: DbMode;
  /** Override; defaults to leased database for mode. */
  databaseName?: string;
  adminUrl?: string;
};

/**
 * After migrations, mark the ensured DB as a PostgreSQL TEMPLATE so workers can clone it.
 * Pass fields from `EnsureResult` (`databaseName` + `adminUrl`) or resolve from the lease.
 */
export async function markTemplate(
  options: MarkTemplateOptions = {},
): Promise<{ databaseName: string }> {
  const identity = resolveWorktreeIdentity(options.root);
  const mode = options.mode ?? "test";
  const lease = readLease(identity.root, mode);
  const databaseName = options.databaseName ?? lease?.databaseName;
  if (!databaseName) {
    throw new Error(`no ${mode} lease; run ensure before markTemplate`);
  }
  const adminUrl = options.adminUrl ?? (await ensureHostRunning()).adminUrl;
  await setDatabaseIsTemplate({ adminUrl, databaseName, isTemplate: true });
  return { databaseName };
}

export type CloneFromTemplateOptions = {
  root?: string;
  mode?: DbMode;
  /**
   * Suffix for the clone datname (e.g. Jest worker id).
   * Defaults to `<pid>_<base36 time>`.
   */
  name?: string;
  /** Inject DATABASE_URL / TEST_DATABASE_URL for this clone (default false). */
  setEnv?: boolean;
};

export type CloneResult = {
  databaseUrl: string;
  adminUrl: string;
  databaseName: string;
  roleName: string;
  templateName: string;
  port: number;
  /** DROP this clone only (leaves TEMPLATE + role if still owned elsewhere). */
  dispose: () => Promise<void>;
};

/**
 * Clone the leased TEMPLATE database via admin (`CREATE DATABASE … TEMPLATE`).
 * Reuses the template role so `databaseUrl` passwords stay valid (scheme v2).
 */
export async function cloneFromTemplate(
  options: CloneFromTemplateOptions = {},
): Promise<CloneResult> {
  const identity = resolveWorktreeIdentity(options.root);
  const mode = options.mode ?? "test";
  const lease = readLease(identity.root, mode);
  if (!lease) {
    throw new Error(`no ${mode} lease; run ensure + markTemplate before cloneFromTemplate`);
  }

  const host = await ensureHostRunning();
  const suffix = options.name ?? `${process.pid}_${Date.now().toString(36)}`;
  const databaseName = buildCloneDatabaseName(lease.databaseName, suffix);

  await cloneDatabaseFromTemplate({
    adminUrl: host.adminUrl,
    templateName: lease.databaseName,
    databaseName,
    roleName: lease.roleName,
  });

  const databaseUrl = buildDatabaseUrl({
    port: host.port,
    databaseName,
    roleName: lease.roleName,
  });

  if (options.setEnv) {
    process.env.DATABASE_URL = databaseUrl;
    if (mode === "test") {
      process.env.TEST_DATABASE_URL = databaseUrl;
    }
  }

  const roleName = lease.roleName;
  const adminUrl = host.adminUrl;

  return {
    databaseUrl,
    adminUrl,
    databaseName,
    roleName,
    templateName: lease.databaseName,
    port: host.port,
    dispose: async () => {
      await dropDatabase({ adminUrl, databaseName, roleName });
    },
  };
}

export type DisposeOptions = {
  root?: string;
  mode?: DbMode;
};

export type DisposeResult =
  | { dropped: true; databaseName: string; droppedDatabases: string[] }
  | { dropped: false; reason: "no-lease" | "host-unavailable" };

/**
 * DROP every database owned by the lease role (TEMPLATE + clones), then forget the lease.
 * Unsets `IS_TEMPLATE` as needed. No-ops without a valid lease (never invents a DROP target).
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
