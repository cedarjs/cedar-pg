import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIRNAME } from "./constants.ts";
import type { DbMode } from "./naming.ts";

export type Lease = {
  schemaVersion: 1;
  mode: DbMode;
  root: string;
  repoSlug: string;
  worktreeSlug: string;
  pathHash: string;
  databaseName: string;
  roleName: string;
  port: number;
  pid: number;
  createdAt: string;
};

function isDbMode(value: unknown): value is DbMode {
  return value === "dev" || value === "test";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Narrow-parse a lease; reject incomplete or wrong-version records. */
export function parseLease(raw: unknown): Lease | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== 1) return null;
  if (!isDbMode(o.mode)) return null;
  if (!isNonEmptyString(o.root)) return null;
  if (!isNonEmptyString(o.repoSlug)) return null;
  if (!isNonEmptyString(o.worktreeSlug)) return null;
  if (!isNonEmptyString(o.pathHash)) return null;
  if (!isNonEmptyString(o.databaseName)) return null;
  if (!isNonEmptyString(o.roleName)) return null;
  if (typeof o.port !== "number") return null;
  if (typeof o.pid !== "number") return null;
  if (!isNonEmptyString(o.createdAt)) return null;
  return {
    schemaVersion: 1,
    mode: o.mode,
    root: o.root,
    repoSlug: o.repoSlug,
    worktreeSlug: o.worktreeSlug,
    pathHash: o.pathHash,
    databaseName: o.databaseName,
    roleName: o.roleName,
    port: o.port,
    pid: o.pid,
    createdAt: o.createdAt,
  };
}

export function leaseDir(root: string): string {
  return join(root, STATE_DIRNAME);
}

export function leasePath(root: string, mode: DbMode): string {
  return join(leaseDir(root), `${mode}.json`);
}

/** Durable registry outside worktrees so GC can find orphans after a checkout is deleted. */
export function registryDir(): string {
  return process.env.CEDAR_PG_REGISTRY_DIR || join(homedir(), STATE_DIRNAME, "registry");
}

function registryPath(databaseName: string): string {
  return join(registryDir(), `${databaseName}.json`);
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function registerLease(lease: Lease): void {
  writeJsonAtomic(registryPath(lease.databaseName), lease);
}

function unregisterLease(databaseName: string): void {
  try {
    unlinkSync(registryPath(databaseName));
  } catch {
    // missing is fine
  }
}

function peekDatabaseName(root: string, mode: DbMode): string | undefined {
  const file = leasePath(root, mode);
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { databaseName?: unknown };
    return typeof raw.databaseName === "string" && raw.databaseName ? raw.databaseName : undefined;
  } catch {
    return undefined;
  }
}

export function readLease(root: string, mode: DbMode): Lease | null {
  const file = leasePath(root, mode);
  if (!existsSync(file)) return null;
  try {
    return parseLease(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Persist lease. Registry is written first (GC source of truth), then the worktree cache.
 */
export function writeLease(lease: Lease): void {
  registerLease(lease);
  const dir = leaseDir(lease.root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(leasePath(lease.root, lease.mode), lease);
}

/**
 * Remove registry entry by databaseName and best-effort delete the worktree lease file.
 * Call only after a successful DROP (or when intentionally abandoning tracking).
 */
export function forgetLease(lease: Pick<Lease, "root" | "mode" | "databaseName">): void {
  unregisterLease(lease.databaseName);
  try {
    unlinkSync(leasePath(lease.root, lease.mode));
  } catch {
    // root or file may already be gone
  }
}

/**
 * Clear worktree lease + registry. Unregisters by databaseName even when the local
 * file fails full parse (peeks databaseName from raw JSON).
 */
export function clearLease(root: string, mode: DbMode): void {
  const existing = readLease(root, mode);
  if (existing) {
    forgetLease(existing);
    return;
  }
  const databaseName = peekDatabaseName(root, mode);
  try {
    unlinkSync(leasePath(root, mode));
  } catch {
    // missing is fine
  }
  if (databaseName) {
    unregisterLease(databaseName);
  }
}

/** All registry entries (used by gc). */
export function listRegistryLeases(): Lease[] {
  const dir = registryDir();
  if (!existsSync(dir)) return [];
  const out: Lease[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const lease = parseLease(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (lease) out.push(lease);
    } catch {
      // skip corrupt
    }
  }
  return out;
}

export function isOrphanLease(lease: Lease): boolean {
  return !existsSync(lease.root);
}
