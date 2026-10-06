import { mkdirSync, writeFileSync } from "node:fs";
import { CLI_NAME } from "./constants.ts";
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
import { applyDatabaseUrlEnv, runIfNeeded, type ResolveAcquireSkipInput } from "./policy.ts";
import { resolveRoot, resolveWorktreeIdentity } from "./worktree.ts";
import { buildDatabaseUrl, dropDatabasesOwnedByRole, ensureDatabase } from "../providers/autopg.ts";
import { ensureHostRunning, waitForListener } from "../providers/host.ts";

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

export type AcquireOptions = {
  root?: string;
  mode: DbMode;
  /** Inject DATABASE_URL / TEST_DATABASE_URL into process.env (default true). */
  setEnv?: boolean;
  /**
   * Start from an empty database (default false): first DROP every database
   * owned by this worktree's role for `mode` — the leased DB, TEMPLATE clones,
   * crashed-run leftovers — then create it again. Scoped by the derived role
   * name, so it works without a lease file and never touches other worktrees.
   */
  fresh?: boolean;
};

export type AcquireResult = {
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
 * Acquire a worktree-scoped database and return connection info.
 *
 * - `dev`: keep DB across restarts.
 * - `test`: DROP when `dispose()` is awaited (callers / test runners own teardown).
 */
export async function acquire(options: AcquireOptions): Promise<AcquireResult> {
  const identity = resolveWorktreeIdentity(options.root);
  const mode = options.mode;
  const databaseName = buildDatabaseName(identity, mode);
  const roleName = buildRoleName(databaseName);

  const host = await ensureHostRunning();
  if (options.fresh) {
    await dropDatabasesOwnedByRole({
      adminUrl: host.adminUrl,
      roleName,
      preferLast: databaseName,
    });
  }
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

/**
 * Attach-only: connection info from the lease a prior `acquire` wrote. Never
 * acquires, never runs role/database DDL, never starts or revives the host —
 * safe for many concurrent children after one `db:ready`. Throws when there is
 * no lease or nothing accepts TCP on the leased port.
 */
export async function attach(options: {
  root?: string;
  mode: DbMode;
}): Promise<{ lease: Lease; databaseUrl: string }> {
  const root = resolveRoot(options.root);
  const mode = options.mode;
  const lease = readLease(root, mode);
  if (!lease) {
    throw new Error(
      `no ${mode} lease in ${root}; run \`${CLI_NAME} acquire --mode=${mode}\` ` +
        `(or your db:ready target) first — attach never acquires`,
    );
  }
  if (!(await waitForListener({ port: lease.port }))) {
    throw new Error(
      `${mode} lease ${lease.databaseName} points at 127.0.0.1:${lease.port}, but nothing is ` +
        `listening; re-run \`${CLI_NAME} acquire --mode=${mode}\` to bring the host back`,
    );
  }
  return { lease, databaseUrl: urlFromLease(lease) };
}

export type AcquireIfNeededOptions = AcquireOptions & ResolveAcquireSkipInput;

export type AcquireIfNeededResult =
  | { status: "skipped"; reason: "disabled" }
  | { status: "skipped"; reason: "external-url"; databaseUrl: string }
  | ({ status: "acquired" } & AcquireResult);

/**
 * Resolve skip policy then acquire. Single entry for hosts (Cedar CLI, Jest, Vitest).
 * On external-url skip, applies DATABASE_URL / TEST_DATABASE_URL when `setEnv` is not false.
 */
export async function acquireIfNeeded(
  options: AcquireIfNeededOptions,
): Promise<AcquireIfNeededResult> {
  const outcome = await runIfNeeded(options, () =>
    acquire({
      root: options.root,
      mode: options.mode,
      setEnv: options.setEnv,
      fresh: options.fresh,
    }),
  );
  if (outcome.status === "skipped") return outcome;
  return { status: "acquired", ...outcome.value };
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
