import { mkdirSync, writeFileSync } from "node:fs";
import { buildDatabaseName, buildRoleName, type DbMode } from "./naming.ts";
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
import { buildDatabaseUrl, dropDatabase, ensureDatabase } from "../providers/autopg.ts";
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
 * DROP the database, then forget lease/registry. Never forget without a successful DROP.
 */
async function dropThenForget(lease: Lease, adminUrl: string): Promise<void> {
  await dropDatabase({
    adminUrl,
    databaseName: lease.databaseName,
    roleName: lease.roleName,
  });
  forgetLease(lease);
}

export type EnsureOptions = {
  root?: string;
  mode: DbMode;
  /** Inject DATABASE_URL / TEST_DATABASE_URL into process.env (default true). */
  setEnv?: boolean;
};

export type EnsureResult = {
  databaseUrl: string;
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

export type DisposeOptions = {
  root?: string;
  mode?: DbMode;
};

export type DisposeResult =
  | { dropped: true; databaseName: string }
  | { dropped: false; reason: "no-lease" | "host-unavailable" };

/**
 * DROP the worktree database for the given mode (default: test).
 * No-ops without a valid lease (never invents a name to DROP).
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

  await dropThenForget(lease, host.adminUrl);
  return { dropped: true, databaseName: lease.databaseName };
}

/**
 * Drop databases whose registered worktree root no longer exists on disk.
 * Registry entries are removed only after a successful DROP.
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
      await dropThenForget(lease, host.adminUrl);
      dropped.push(lease.databaseName);
    } catch {
      // Keep registry entry for retry
    }
  }
  return { dropped };
}
