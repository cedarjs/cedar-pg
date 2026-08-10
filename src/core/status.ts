import { CLI_NAME } from "./constants.ts";
import { envFilePath, readLease, type Lease } from "./lease.ts";
import { urlFromLease } from "./lifecycle.ts";
import type { DbMode } from "./naming.ts";
import { resolveWorktreeIdentity } from "./worktree.ts";

export type ResolveDevStatusOptions = {
  root?: string;
  mode?: DbMode;
};

export type DevStatusOk = {
  ok: true;
  mode: DbMode;
  root: string;
  lease: Lease;
  databaseUrl: string;
  envPath: string;
};

export type DevStatusMissing = {
  ok: false;
  reason: "no-lease";
  mode: DbMode;
  root: string;
};

export type DevStatus = DevStatusOk | DevStatusMissing;

/** Read-only lease snapshot for CLI / Vite panel (no acquire, no host). */
export function resolveDevStatus(options: ResolveDevStatusOptions = {}): DevStatus {
  const mode = options.mode ?? "dev";
  const { root } = resolveWorktreeIdentity(options.root);
  const lease = readLease(root, mode);
  if (!lease) {
    return { ok: false, reason: "no-lease", mode, root };
  }
  return {
    ok: true,
    mode,
    root,
    lease,
    databaseUrl: urlFromLease(lease),
    envPath: envFilePath(root, mode),
  };
}

/** Human-readable lines for the Vite panel / `cedarpg status`. */
export function formatDevStatus(status: DevStatus): string[] {
  if (!status.ok) {
    return [
      `${CLI_NAME}: no ${status.mode} lease at ${status.root}`,
      `  run \`${CLI_NAME} acquire --mode=${status.mode}\` (or depend on db:acquire)`,
    ];
  }
  const { lease, databaseUrl, envPath } = status;
  return [
    `${CLI_NAME}: ${lease.databaseName} (${lease.repoSlug}/${lease.worktreeSlug} ${lease.mode})`,
    `  port          ${lease.port}`,
    `  DATABASE_URL  ${databaseUrl}`,
    `  env           ${envPath}`,
  ];
}
