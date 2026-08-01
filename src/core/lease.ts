import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

export function leaseDir(root: string): string {
  return join(root, ".cedar-pg");
}

export function leasePath(root: string, mode: DbMode): string {
  return join(leaseDir(root), `${mode}.json`);
}

export function readLease(root: string, mode: DbMode): Lease | null {
  const file = leasePath(root, mode);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Lease;
    if (raw?.schemaVersion !== 1) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeLease(lease: Lease): void {
  const dir = leaseDir(lease.root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = leasePath(lease.root, lease.mode);
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function clearLease(root: string, mode: DbMode): void {
  const file = leasePath(root, mode);
  try {
    unlinkSync(file);
  } catch {
    // missing is fine
  }
}
