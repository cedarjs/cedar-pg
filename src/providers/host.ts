import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statfsSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adminUrlFor,
  discoverHost,
  INSTALL_HINT,
  requireAutopgBin,
  type AutopgDiscovery,
} from "./autopg.ts";

/** How cedar-pg starts an autopg host when none is already live. */
export type HostStartPolicy = "local" | "ephemeral";

/** Opinionated install + postmaster argv for CI / ephemeral runners. */
export type EphemeralHostRecipe = {
  dataDir: string;
  port: number;
  installArgs: string[];
  postmasterArgs: string[];
};

/** Inputs for {@link ephemeralHostRecipe} (production uses process defaults). */
export type EphemeralRecipeContext = {
  platform?: NodeJS.Platform;
  shmAvailable?: boolean;
  tmpDir?: string;
  uid?: number;
  port?: number;
};

/** Fixed CI TCP port so install registration and postmaster listen on the same port. */
const EPHEMERAL_PORT = 55432;

const OWNED_POSTMASTER_READY_MS = 30_000;
const OWNED_POSTMASTER_POLL_MS = 200;

/** Soft minimum free bytes on /dev/shm before RAM-backed ephemeral start (warns only). */
export const EPHEMERAL_SHM_MIN_FREE_BYTES = 512 * 1024 * 1024;

/**
 * Hint when ephemeral `--ram` initdb fails for space / leftover dirs under `/dev/shm`.
 * Cloud VMs often ship with a tiny default tmpfs (e.g. 64MB).
 */
export const EPHEMERAL_SHM_HINT =
  "Ephemeral autopg uses /dev/shm with --ram. If initdb fails with Disk quota / No space (Postgres 53100):\n" +
  "  1. Enlarge tmpfs (cloud VMs often default to ~64MB): sudo mount -o remount,size=6G /dev/shm\n" +
  "  2. Clear leftovers from OOM-killed runs (your test data only):\n" +
  "     rm -rf /dev/shm/cedar-pg-* /dev/shm/pgserve-* /dev/shm/PostgreSQL.*";

/**
 * Resolve whether to start an owned ephemeral postmaster or use local pm2 install.
 *
 * - `CEDAR_PG_EPHEMERAL_HOST=1` → ephemeral
 * - `CEDAR_PG_EPHEMERAL_HOST=0` → local (even when `CI=true`)
 * - unset + `CI=true` → ephemeral
 * - otherwise → local
 */
export function resolveEphemeralHostPolicy(env: NodeJS.ProcessEnv = process.env): HostStartPolicy {
  const force = env.CEDAR_PG_EPHEMERAL_HOST;
  if (force === "1") return "ephemeral";
  if (force === "0") return "local";
  if (env.CI === "true") return "ephemeral";
  return "local";
}

/**
 * Fixed CI recipe: shared `--port` on install + postmaster, `--no-pm2 --no-ui`,
 * and `--ram` + `/dev/shm/cedar-pg-<uid>` on Linux when shm exists.
 */
export function ephemeralHostRecipe(ctx: EphemeralRecipeContext = {}): EphemeralHostRecipe {
  const platform = ctx.platform ?? process.platform;
  const shmAvailable = ctx.shmAvailable ?? (platform === "linux" && existsSync("/dev/shm"));
  const uid = ctx.uid ?? process.getuid?.() ?? 0;
  const port = ctx.port ?? EPHEMERAL_PORT;
  const useRam = platform === "linux" && shmAvailable;
  const dataDir = useRam
    ? `/dev/shm/cedar-pg-${uid}`
    : join(ctx.tmpDir ?? tmpdir(), "cedar-pg-host");

  const installArgs = ["install", "--no-pm2", "--no-ui", "--port", String(port), "--data", dataDir];
  // Always pass --port/--data/--socket-dir so postmaster matches the install record.
  const postmasterArgs = [
    "postmaster",
    ...(useRam ? ["--ram"] : []),
    "--port",
    String(port),
    "--socket-dir",
    dataDir,
    "--data",
    dataDir,
  ];

  return { dataDir, port, installArgs, postmasterArgs };
}

/** Discovery from the recipe port — TCP readiness is the authority, not `autopg status`. */
export function discoveryFromRecipe(bin: string, recipe: EphemeralHostRecipe): AutopgDiscovery {
  return { port: recipe.port, adminUrl: adminUrlFor(recipe.port), bin };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when stderr/stdout looks like a /dev/shm quota or ENOSPC failure. */
export function looksLikeShmSpaceError(text: string): boolean {
  return /Disk quota exceeded|No space left on device|ENOSPC|\b53100\b/i.test(text);
}

export function formatHostStartError(detail: string, useRamShm: boolean): string {
  const hint = useRamShm && looksLikeShmSpaceError(detail) ? `\n${EPHEMERAL_SHM_HINT}` : "";
  return `Failed to start autopg host.\n${detail}\n${INSTALL_HINT}${hint}`;
}

/**
 * Remove leftover ephemeral data dirs under `/dev/shm` (and the recipe dataDir)
 * when the recipe port is not live. Safe for OOM-killed CI/cloud runs that leave
 * `cedar-pg-*` / `pgserve-*` / `PostgreSQL.*` filling tmpfs.
 *
 * Does nothing when `portLive` is true (another host owns the port).
 */
export function pruneStaleEphemeralDataDirs(opts: {
  dataDir: string;
  /** Parent of RAM dirs; default `/dev/shm` when it exists. */
  shmRoot?: string;
  /** When true, skip all deletes. */
  portLive: boolean;
}): string[] {
  if (opts.portLive) return [];

  const removed: string[] = [];
  const tryRm = (path: string) => {
    if (!existsSync(path)) return;
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // best-effort: next initdb will surface a clearer error
    }
  };

  tryRm(opts.dataDir);

  const shmRoot = opts.shmRoot ?? (existsSync("/dev/shm") ? "/dev/shm" : undefined);
  if (!shmRoot) return removed;

  let entries: string[] = [];
  try {
    entries = readdirSync(shmRoot);
  } catch {
    return removed;
  }

  for (const name of entries) {
    if (
      name.startsWith("cedar-pg-") ||
      name.startsWith("pgserve-") ||
      name.startsWith("PostgreSQL.")
    ) {
      tryRm(join(shmRoot, name));
    }
  }
  return removed;
}

/** Free bytes on `path`, or `null` if unavailable. */
export function freeBytesOn(path: string): number | null {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function runInstall(bin: string, args: string[], useRamShm: boolean): void {
  const install = spawnSync(bin, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (install.status !== 0) {
    const detail = `exit ${install.status}\n${install.stderr || install.stdout || ""}`.trim();
    throw new Error(formatHostStartError(detail, useRamShm));
  }
}

/** True when something accepts TCP on 127.0.0.1:port (postmaster live, not just admin.json). */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => {
      resolve(false);
    });
  });
}

/** Kill a detached owned postmaster (process group when possible) and drop our handle. */
function killOwnedChild(child: ChildProcess): void {
  const pid = child.pid;
  if (pid != null) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
  }
  child.unref();
}

export type WaitForOwnedPostmasterOptions = {
  port: number;
  readyMs?: number;
  pollMs?: number;
  canConnect?: (port: number) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Return an Error to fail fast (spawn error / early exit). */
  failure?: () => Error | null;
};

/**
 * Poll until TCP accepts on port, or throw on timeout / {@link WaitForOwnedPostmasterOptions.failure}.
 * Exported for tests — the readiness seam for owned ephemeral start.
 */
export async function waitForOwnedPostmaster(opts: WaitForOwnedPostmasterOptions): Promise<void> {
  const probe = opts.canConnect ?? canConnect;
  const now = opts.now ?? Date.now;
  const pause = opts.sleep ?? sleep;
  const readyMs = opts.readyMs ?? OWNED_POSTMASTER_READY_MS;
  const pollMs = opts.pollMs ?? OWNED_POSTMASTER_POLL_MS;
  const deadline = now() + readyMs;
  let lastDetail = "TCP not accepting";

  while (now() < deadline) {
    const fail = opts.failure?.();
    if (fail) throw fail;
    if (await probe(opts.port)) return;
    lastDetail = `127.0.0.1:${opts.port} not accepting connections`;
    await pause(pollMs);
  }

  throw new Error(
    `Timed out waiting for autopg host after ${readyMs}ms.\n${lastDetail}\n${INSTALL_HINT}`,
  );
}

/**
 * Install + detached postmaster with fully ignored stdio so the CI job owns lifetime
 * (caller exit must not close pipes under the daemon).
 *
 * Readiness is TCP accept on the recipe port — not `autopg status`, which succeeds
 * after `install --no-pm2` before postmaster is listening. On success, discovery is
 * recipe-derived (same port). On failure, the spawned child is killed.
 */
async function startEphemeralHost(bin: string): Promise<AutopgDiscovery> {
  const recipe = ephemeralHostRecipe();
  const useRamShm = recipe.postmasterArgs.includes("--ram");
  const portLive = await canConnect(recipe.port);

  pruneStaleEphemeralDataDirs({
    dataDir: recipe.dataDir,
    portLive,
  });

  if (useRamShm && !portLive) {
    const free = freeBytesOn("/dev/shm");
    if (free != null && free < EPHEMERAL_SHM_MIN_FREE_BYTES) {
      process.stderr.write(
        `[cedar-pg] warning: /dev/shm has ~${Math.round(free / (1024 * 1024))}MB free ` +
          `(recommend ≥${Math.round(EPHEMERAL_SHM_MIN_FREE_BYTES / (1024 * 1024))}MB for --ram).\n` +
          `${EPHEMERAL_SHM_HINT}\n`,
      );
    }
  }

  mkdirSync(recipe.dataDir, { recursive: true });
  runInstall(bin, recipe.installArgs, useRamShm);

  const state: {
    exit: { code: number | null; signal: NodeJS.Signals | null } | null;
    spawnError: Error | null;
  } = { exit: null, spawnError: null };

  const child = spawn(bin, recipe.postmasterArgs, {
    detached: true,
    // Fully ignore stdio so unref'd postmaster is not tied to this process's pipes.
    stdio: "ignore",
  });
  child.on("error", (err) => {
    state.spawnError = err;
  });
  child.on("exit", (code, signal) => {
    state.exit = { code, signal };
  });

  try {
    await waitForOwnedPostmaster({
      port: recipe.port,
      failure: () => {
        if (state.spawnError) {
          return new Error(
            formatHostStartError(
              `Failed to spawn autopg postmaster.\n${state.spawnError.message}`,
              useRamShm,
            ),
          );
        }
        if (state.exit) {
          return new Error(
            formatHostStartError(
              `autopg postmaster exited before ready (code=${state.exit.code}, signal=${state.exit.signal}).`,
              useRamShm,
            ),
          );
        }
        return null;
      },
    });
  } catch (err) {
    killOwnedChild(child);
    throw err;
  }

  // Success: job owns lifetime — drop our handle without killing.
  child.unref();
  return discoveryFromRecipe(bin, recipe);
}

/**
 * Ensure the host postmaster is up.
 *
 * - Attaches when `autopg status --json` shows a live host.
 * - Otherwise starts from {@link resolveEphemeralHostPolicy}: local pm2 `install`,
 *   or opinionated ephemeral (`--no-pm2 --no-ui` + detached postmaster).
 * - CI job owns ephemeral postmaster lifetime on success (no cedar-pg host dispose).
 * - Failed ephemeral start kills the spawned child so ensure is atomic for the caller.
 * - Before ephemeral cold-start, prunes stale `/dev/shm` leftovers when the recipe port is dead.
 */
export async function ensureHostRunning(bin = requireAutopgBin()): Promise<AutopgDiscovery> {
  try {
    return discoverHost(bin);
  } catch {
    // status failed — start host per policy
  }

  if (resolveEphemeralHostPolicy() === "ephemeral") {
    return startEphemeralHost(bin);
  }

  runInstall(bin, ["install"], false);
  return discoverHost(bin);
}
