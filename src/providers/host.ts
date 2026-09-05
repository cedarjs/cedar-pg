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

/** How cedar-pg brings up an autopg host when nothing is listening. */
export type HostStartPolicy = "local" | "ephemeral";

export type EphemeralHostRecipe = {
  dataDir: string;
  port: number;
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

const EPHEMERAL_PORT = 55432;

const HOST_READY_MS = 30_000;
const HOST_POLL_MS = 200;
/** `pm2 restart` of an existing process is quick; 30s is only for first `install` / initdb. */
const LOCAL_RESTART_READY_MS = 10_000;

/**
 * autopg verbs that can bring the *registered* local host up, cheapest fix first.
 *
 * `restart` exit 0 is not evidence of a listener: when pm2 is missing or does not
 * list `autopg-server`, autopg still prints "respawned daemon" and returns 0.
 * That is why every verb is followed by a TCP wait, not trusted on exit status.
 *
 * `install` covers a never-registered machine (postinstall ships the binary only)
 * and a reboot whose pm2 list is empty (`pm2 start`). On an already-registered
 * host it is a no-op for the server process but may `pm2 start` the autopg UI —
 * so it runs only after `restart` failed to produce a listener.
 */
const LOCAL_START = [
  { argv: ["restart"], readyMs: LOCAL_RESTART_READY_MS },
  { argv: ["install"], readyMs: HOST_READY_MS },
] as const;

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
 * Resolve how to start a host when none is listening.
 *
 * - `CEDAR_PG_EPHEMERAL_HOST=1` → ephemeral owned postmaster
 * - `CEDAR_PG_EPHEMERAL_HOST=0` → never own a postmaster, local autopg only (even in CI)
 * - unset + `CI=true` → ephemeral
 * - otherwise → local
 */
export function resolveHostStartPolicy(env: NodeJS.ProcessEnv = process.env): HostStartPolicy {
  const force = env.CEDAR_PG_EPHEMERAL_HOST;
  if (force === "1") return "ephemeral";
  if (force === "0") return "local";
  if (env.CI === "true") return "ephemeral";
  return "local";
}

export function ephemeralHostRecipe(ctx: EphemeralRecipeContext = {}): EphemeralHostRecipe {
  const platform = ctx.platform ?? process.platform;
  const shmAvailable = ctx.shmAvailable ?? (platform === "linux" && existsSync("/dev/shm"));
  const uid = ctx.uid ?? process.getuid?.() ?? 0;
  const port = ctx.port ?? EPHEMERAL_PORT;
  const useRam = platform === "linux" && shmAvailable;
  const dataDir = useRam
    ? `/dev/shm/cedar-pg-${uid}`
    : join(ctx.tmpDir ?? tmpdir(), "cedar-pg-host");

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

  return { dataDir, port, postmasterArgs };
}

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

export function formatHostStartError(detail: string, useRamShm = false): string {
  const hint = useRamShm && looksLikeShmSpaceError(detail) ? `\n${EPHEMERAL_SHM_HINT}` : "";
  return `Failed to start autopg host.\n${detail}\n${INSTALL_HINT}${hint}`;
}

/**
 * Remove leftover ephemeral data dirs under `/dev/shm` (and the recipe dataDir).
 * Safe for OOM-killed CI/cloud runs that leave `cedar-pg-*` / `pgserve-*` /
 * `PostgreSQL.*` filling tmpfs.
 *
 * Only called on ephemeral cold start, i.e. when the recipe port has no listener —
 * never while a host owns those dirs.
 */
export function pruneStaleEphemeralDataDirs(opts: {
  dataDir: string;
  /** Parent of RAM dirs; default `/dev/shm` when it exists. */
  shmRoot?: string;
}): string[] {
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
function freeBytesOn(path: string): number | null {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Run a one-shot autopg verb. Returns failure detail, or `null` on exit 0. */
function runAutopg(bin: string, argv: string[]): string | null {
  const result = spawnSync(bin, argv, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) return result.error.message;
  if (result.status === 0) return null;
  return `exit ${result.status}\n${(result.stderr || result.stdout || "").trim()}`.trim();
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

export type WaitForListenerOptions = {
  port: number;
  /** Total grace period; `0` (default) probes exactly once. */
  readyMs?: number;
  pollMs?: number;
  canConnect?: (port: number) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Return an Error to abort early (spawn error / child exit). */
  failure?: () => Error | null;
};

/**
 * The single liveness primitive: TCP accept on 127.0.0.1:port.
 *
 * Resolves `true` as soon as something is listening, `false` when the grace
 * period expires, and throws only what {@link WaitForListenerOptions.failure}
 * returns. Used for attach (one probe), local restart, and ephemeral start.
 */
export async function waitForListener(opts: WaitForListenerOptions): Promise<boolean> {
  const probe = opts.canConnect ?? canConnect;
  const now = opts.now ?? Date.now;
  const pause = opts.sleep ?? sleep;
  const pollMs = opts.pollMs ?? HOST_POLL_MS;
  const deadline = now() + (opts.readyMs ?? 0);

  for (;;) {
    const fail = opts.failure?.();
    if (fail) throw fail;
    if (await probe(opts.port)) return true;
    if (now() >= deadline) return false;
    await pause(pollMs);
  }
}

/**
 * Attach to the registered autopg host once TCP accepts on its port.
 *
 * Registration is not liveness: a stopped pm2 host still reports a port, and
 * attaching to it is the `ECONNREFUSED 127.0.0.1:25432` bug. `readyMs` > 0 is
 * the grace period after asking autopg to start.
 */
async function attachLiveHost(bin: string, readyMs = 0): Promise<AutopgDiscovery | null> {
  let discovered: AutopgDiscovery;
  try {
    discovered = discoverHost(bin);
  } catch {
    return null;
  }
  return (await waitForListener({ port: discovered.port, readyMs })) ? discovered : null;
}

/**
 * Bring the user's registered autopg host up and attach to it — same port, same
 * `~/.autopg/data`, still there after this process exits. cedar-pg never runs a
 * second local Postgres.
 */
async function startLocalHost(bin: string, registeredPort?: number): Promise<AutopgDiscovery> {
  const failures: string[] = [];

  for (const { argv, readyMs } of LOCAL_START) {
    const label = `autopg ${argv.join(" ")}`;
    const failure = runAutopg(bin, [...argv]);
    if (failure) {
      failures.push(`${label}: ${failure}`);
      continue;
    }
    const attached = await attachLiveHost(bin, readyMs);
    if (attached) return attached;
    failures.push(`${label}: no listener within ${readyMs}ms`);
  }

  const where =
    registeredPort != null
      ? `autopg host is registered on 127.0.0.1:${registeredPort} but nothing is listening.\n`
      : "";
  throw new Error(formatHostStartError(`${where}${failures.join("\n")}`));
}

/**
 * Ephemeral host owned by this process/job: detached `autopg postmaster` with
 * fully ignored stdio (caller exit must not close pipes under the daemon).
 *
 * Never runs `autopg install` — that rewrites `~/.autopg/admin.json` and fails
 * with `supervisor mismatch` next to a local pm2 install. Reuses a listener
 * already on the recipe port, and prunes stale RAM dirs before a cold start.
 */
async function startEphemeralHost(bin: string): Promise<AutopgDiscovery> {
  const recipe = ephemeralHostRecipe();
  if (await canConnect(recipe.port)) return discoveryFromRecipe(bin, recipe);

  const useRamShm = recipe.postmasterArgs.includes("--ram");
  pruneStaleEphemeralDataDirs({ dataDir: recipe.dataDir });

  if (useRamShm) {
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

  const child = spawn(bin, recipe.postmasterArgs, { detached: true, stdio: "ignore" });
  let died: Error | null = null;
  child.on("error", (err) => {
    died = new Error(
      formatHostStartError(`Failed to spawn autopg postmaster.\n${err.message}`, useRamShm),
    );
  });
  child.on("exit", (code, signal) => {
    died ??= new Error(
      formatHostStartError(
        `autopg postmaster exited before ready (code=${code}, signal=${signal}).`,
        useRamShm,
      ),
    );
  });

  try {
    const listening = await waitForListener({
      port: recipe.port,
      readyMs: HOST_READY_MS,
      failure: () => died,
    });
    if (!listening) {
      throw new Error(
        formatHostStartError(
          `autopg postmaster did not accept 127.0.0.1:${recipe.port} within ${HOST_READY_MS}ms.`,
          useRamShm,
        ),
      );
    }
  } catch (err) {
    killOwnedChild(child);
    throw err;
  }

  // Success: the process/job owns lifetime — drop our handle without killing.
  child.unref();
  return discoveryFromRecipe(bin, recipe);
}

/**
 * Attach to a listening autopg host, else start one per
 * {@link resolveHostStartPolicy}. Internal: callers use `acquire` / `adminUrl`.
 */
export async function ensureHostRunning(bin = requireAutopgBin()): Promise<AutopgDiscovery> {
  let registered: AutopgDiscovery | null = null;
  try {
    registered = discoverHost(bin);
  } catch {
    // no registration — local recovery may `install`
  }
  if (registered && (await waitForListener({ port: registered.port }))) return registered;

  return resolveHostStartPolicy() === "ephemeral"
    ? startEphemeralHost(bin)
    : startLocalHost(bin, registered?.port);
}
