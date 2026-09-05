import { envPath, readLease, type Lease } from "./lease.ts";
import { urlFromLease } from "./lifecycle.ts";
import type { DbMode } from "./naming.ts";
import { resolveRoot } from "./worktree.ts";

export type ResolveDevStatusOptions = {
  root?: string;
  mode?: DbMode;
};

export type DevStatus =
  | {
      ok: true;
      mode: DbMode;
      root: string;
      lease: Lease;
      databaseUrl: string;
      envPath: string;
    }
  | {
      ok: false;
      mode: DbMode;
      root: string;
    };

/** Read-only lease snapshot for CLI / Vite panel (no acquire, no host). */
export function resolveDevStatus(options: ResolveDevStatusOptions = {}): DevStatus {
  const mode = options.mode ?? "dev";
  const root = resolveRoot(options.root);
  const lease = readLease(root, mode);
  if (!lease) {
    return { ok: false, mode, root };
  }
  return {
    ok: true,
    mode,
    root,
    lease,
    databaseUrl: urlFromLease(lease),
    envPath: envPath(root, mode),
  };
}
