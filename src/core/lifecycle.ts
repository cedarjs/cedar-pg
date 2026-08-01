import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDatabaseName, buildRoleName, type DbMode } from "./naming.ts";
import { clearLease, leaseDir, readLease, writeLease, type Lease } from "./lease.ts";
import { resolveWorktreeIdentity } from "./worktree.ts";
import {
  buildDatabaseUrl,
  dropDatabase,
  ensureDatabase,
  ensureHostRunning,
} from "../providers/autopg.ts";

function writeEnvFile(root: string, mode: DbMode, databaseUrl: string): void {
  const dir = leaseDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let body = `DATABASE_URL=${databaseUrl}\n`;
  if (mode === "test") body += `TEST_DATABASE_URL=${databaseUrl}\n`;
  writeFileSync(join(dir, `${mode}.env`), body, { mode: 0o600 });
}

export type EnsureOptions = {
  root?: string;
  mode: DbMode;
  /** When true (default for test), register process exit dispose. */
  disposeOnExit?: boolean;
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

let exitHookInstalled = false;
const pendingTestDisposes = new Set<() => Promise<void>>();

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;

  const run = () => {
    const jobs = [...pendingTestDisposes];
    pendingTestDisposes.clear();
    for (const job of jobs) {
      try {
        // best-effort sync-ish: fire and forget with sync wait via spawn would be better,
        // but async dispose uses pg — use deasync-free approach: void promise
        void job();
      } catch {
        // ignore
      }
    }
  };

  process.once("beforeExit", run);
  process.once("exit", run);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      run();
      // allow default signal behavior after scheduling dispose
    });
  }
}

/**
 * Ensure a worktree-scoped database exists and return connection info.
 *
 * - `dev`: keep DB across restarts; lease cleared on signal but DB kept.
 * - `test`: DROP on dispose / process exit.
 */
export async function ensure(options: EnsureOptions): Promise<EnsureResult> {
  const identity = resolveWorktreeIdentity(options.root);
  const mode = options.mode;
  const databaseName = buildDatabaseName(identity, mode);
  const roleName = buildRoleName(databaseName);

  const host = ensureHostRunning();
  await ensureDatabase({
    adminUrl: host.adminUrl,
    databaseName,
    roleName,
  });

  const databaseUrl = buildDatabaseUrl({
    port: host.port,
    databaseName,
    roleName,
    socketDir: host.socketDir,
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

  const setEnv = options.setEnv !== false;
  if (setEnv) {
    process.env.DATABASE_URL = databaseUrl;
    if (mode === "test") {
      process.env.TEST_DATABASE_URL = databaseUrl;
    }
  }

  const disposeFn = async () => {
    pendingTestDisposes.delete(disposeFn);
    await dispose({ root: identity.root, mode });
  };

  if (mode === "test" && options.disposeOnExit !== false) {
    pendingTestDisposes.add(disposeFn);
    installExitHook();
  }

  if (mode === "dev") {
    // Soft signal: clear lease only — keep DB
    const soft = () => {
      clearLease(identity.root, "dev");
    };
    process.once("SIGINT", soft);
    process.once("SIGTERM", soft);
  }

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

export type DisposeOptions = {
  root?: string;
  mode?: DbMode;
};

/**
 * DROP the worktree database for the given mode (default: test).
 */
export async function dispose(options: DisposeOptions = {}): Promise<void> {
  const identity = resolveWorktreeIdentity(options.root);
  const mode = options.mode ?? "test";
  const lease = readLease(identity.root, mode);

  // Only drop DBs we created — never invent a name and DROP without a lease
  // (escape-hatch / external TEST_DATABASE_URL must stay untouched).
  if (!lease) {
    return;
  }

  const databaseName = lease.databaseName;
  const roleName = lease.roleName;

  let host;
  try {
    host = ensureHostRunning();
  } catch {
    clearLease(identity.root, mode);
    return;
  }

  await dropDatabase({
    adminUrl: host.adminUrl,
    databaseName,
    roleName,
  });
  clearLease(identity.root, mode);
}

/**
 * Drop DBs whose lease root no longer exists on disk.
 */
export async function gc(options: { root?: string } = {}): Promise<{
  dropped: string[];
}> {
  const identity = resolveWorktreeIdentity(options.root);
  // Scan sibling? For v1: only check current root's leases if root missing — plus
  // re-read both modes when root exists but is marked for cleanup by caller.
  // Broader GC: look at .cedar-pg under cwd only.
  const dropped: string[] = [];
  if (!existsSync(identity.root)) {
    for (const mode of ["dev", "test"] as const) {
      const lease = readLease(identity.root, mode);
      if (!lease) continue;
      try {
        const host = ensureHostRunning();
        await dropDatabase({
          adminUrl: host.adminUrl,
          databaseName: lease.databaseName,
          roleName: lease.roleName,
        });
        dropped.push(lease.databaseName);
      } catch {
        // continue
      }
      clearLease(identity.root, mode);
    }
  }
  return { dropped };
}
