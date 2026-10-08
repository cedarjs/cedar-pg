import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adminUrlFor,
  discoverHost,
  discoverRegistration,
  INSTALL_HINT,
  outdatedAutopgWarning,
  readAutopgVersion,
  requireAutopgBin,
  type AutopgDiscovery,
  type AutopgRegistration,
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
/** `autopg restart` exits 0 only once ready; grace covers older autopg that returned early. */
const LOCAL_RESTART_READY_MS = 10_000;

/** Soft minimum free bytes on /dev/shm before RAM-backed ephemeral start (warns only). */
export const EPHEMERAL_SHM_MIN_FREE_BYTES = 512 * 1024 * 1024;

/**
 * Hint when ephemeral `--ram` initdb fails for space / leftover dirs under `/dev/shm`.
 * Cloud VMs often ship with a tiny default tmpfs (e.g. 64MB).
 */
export const EPHEMERAL_SHM_HINT =
  "Ephemeral autopg uses /dev/shm with --ram. If initdb fails with Disk quota / No space (Postgres 53100):\n" +
  "  1. Enlarge tmpfs (cloud VMs often default to ~64MB): sudo mount -o remount,size=6G /dev/shm\n" +
  "  2. cedar-pg already removes its own leftover dir (/dev/shm/cedar-pg-<uid>) on cold start.\n" +
  "     Never rm /dev/shm/PostgreSQL.*: those segments belong to every running Postgres,\n" +
  "     and deleting a live one breaks new connections to that host (58P01).";

/**
 * Resolve how to start a host when none is listening.
 *
 * - `CEDAR_PG_EPHEMERAL_HOST=1` → ephemeral owned postmaster
 * - `CEDAR_PG_EPHEMERAL_HOST=0` → never own an ephemeral postmaster, local registered host only (even in CI)
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
  const output = `${result.stderr ?? ""}${result.stdout ?? ""}`;
  return `exit ${result.status}\n${output.trim()}`.trim();
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

/** Appended by the revived registered postmaster (next to autopg's own pm2 logs). */
const REVIVED_POSTMASTER_LOG = "cedarpg-postmaster.log";

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Live PID from `<dataDir>/postmaster.pid`, else `null`. Postgres writes it before
 * binding, so a live owner means another postmaster (pm2 still recovering, or a
 * concurrent acquire) already holds the data dir — wait for it, never compete.
 */
function liveDataDirOwner(dataDir: string): number | null {
  return livePidIn(join(dataDir, "postmaster.pid"));
}

/** Live PID from the first line of `file`, else `null` (missing, garbage, or dead). */
function livePidIn(file: string): number | null {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(file, "utf8"), 10);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? pid : null;
  }
}

/**
 * Exclusive cold-start lock `<dataDir>.lock` holding our PID. Returns `null` once
 * we hold it, else the live holder's PID. `postmaster.pid` alone cannot guard an
 * ephemeral cold start: it does not exist yet while a peer runs initdb, which is
 * exactly when a second `rm -rf` would destroy the peer's cluster.
 *
 * The PID is written to a private file and hard-linked into place, so the lock
 * never exists without its PID. A dead holder's lock is stale and taken over.
 */
function tryColdStartLock(lockPath: string): number | null {
  const mine = `${lockPath}.${process.pid}`;
  writeFileSync(mine, String(process.pid));
  try {
    for (;;) {
      try {
        linkSync(mine, lockPath);
        return null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const holder = livePidIn(lockPath);
      if (holder != null) return holder;
      rmSync(lockPath, { force: true });
    }
  } finally {
    rmSync(mine, { force: true });
  }
}

/**
 * Detached `autopg postmaster`. Success: child is unref'd (survives this process).
 * Failure: child is killed, throws a one-line detail (caller wraps / aggregates).
 * `logFile` (appended) keeps output from a postmaster nothing else supervises;
 * otherwise stdio is fully ignored (caller exit must not close pipes under it).
 */
async function spawnDetachedPostmaster(opts: {
  bin: string;
  args: string[];
  port: number;
  readyMs: number;
  logFile?: string;
}): Promise<void> {
  const { readyMs } = opts;
  const logFd = opts.logFile ? openSync(opts.logFile, "a") : null;
  let child: ChildProcess;
  try {
    child = spawn(opts.bin, opts.args, {
      detached: true,
      stdio: logFd == null ? "ignore" : ["ignore", logFd, logFd],
    });
  } finally {
    if (logFd != null) closeSync(logFd);
  }
  let died: Error | null = null;
  child.on("error", (err) => {
    died = new Error(`Failed to spawn autopg postmaster.\n${err.message}`);
  });
  child.on("exit", (code, signal) => {
    died ??= new Error(`autopg postmaster exited before ready (code=${code}, signal=${signal}).`);
  });

  try {
    const listening = await waitForListener({
      port: opts.port,
      readyMs,
      failure: () => died,
    });
    if (!listening) {
      throw new Error(
        `autopg postmaster did not accept 127.0.0.1:${opts.port} within ${readyMs}ms.`,
      );
    }
  } catch (err) {
    killOwnedChild(child);
    throw err;
  }

  child.unref();
}

/**
 * Detached `autopg postmaster` on the registered port / data dir (socket dir when
 * autopg reports one; otherwise the postmaster resolves autopg's own default).
 * Returns failure detail, or `null` once TCP accepts.
 *
 * No reported `dataDir` → not attempted: a postmaster without `--data` is not
 * persistent, and guessing autopg's path is how a second Postgres happens.
 */
async function reviveRegisteredPostmaster(
  bin: string,
  reg: AutopgRegistration,
): Promise<string | null> {
  const { dataDir, socketDir, logsDir } = reg;
  const { port } = reg.host;
  if (!dataDir) return "autopg postmaster: not attempted (autopg status --json reports no dataDir)";

  const args = [
    "postmaster",
    "--port",
    String(port),
    "--data",
    dataDir,
    ...(socketDir ? ["--socket-dir", socketDir] : []),
  ];
  const label = `autopg ${args.join(" ")}`;
  const logFile = logsDir ? join(logsDir, REVIVED_POSTMASTER_LOG) : undefined;

  if (liveDataDirOwner(dataDir) == null) {
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      if (logsDir) mkdirSync(logsDir, { recursive: true });
      await spawnDetachedPostmaster({
        bin,
        args,
        port,
        readyMs: HOST_READY_MS,
        ...(logFile ? { logFile } : {}),
      });
      return null;
    } catch (err) {
      // Lost the data-dir lock to a concurrent start → wait for the winner below.
      if (liveDataDirOwner(dataDir) == null) {
        return `${label}: ${errorDetail(err)}${logFile ? `\nPostmaster log: ${logFile}` : ""}`;
      }
    }
  }

  if (await waitForListener({ port, readyMs: HOST_READY_MS })) return null;
  return (
    `${label}: postmaster pid ${liveDataDirOwner(dataDir) ?? "?"} owns ${dataDir} ` +
    `but did not accept 127.0.0.1:${port} within ${HOST_READY_MS}ms`
  );
}

/**
 * Revive the user's registered autopg host — same port, same `~/.autopg/data`,
 * still running after this process exits. Never a second local Postgres.
 *
 * `restart` drives pm2 only and exits 0 once ready; without pm2 (or under another
 * supervisor) it exits 1. Either way TCP is the gate: if still dark,
 * {@link reviveRegisteredPostmaster} on the registered port/data. Do not
 * `install` on an already-registered host (wants pm2, refuses a port change).
 * `install` is only for a never-registered machine.
 */
async function startLocalHost(
  bin: string,
  registered: AutopgRegistration | null,
): Promise<AutopgDiscovery> {
  const failures: string[] = [];

  const restartFailure = runAutopg(bin, ["restart"]);
  if (restartFailure) {
    failures.push(`autopg restart: ${restartFailure}`);
  } else {
    const attached = await attachLiveHost(bin, LOCAL_RESTART_READY_MS);
    if (attached) return attached;
    failures.push(`autopg restart: no listener within ${LOCAL_RESTART_READY_MS}ms`);
  }

  if (registered) {
    const failure = await reviveRegisteredPostmaster(bin, registered);
    if (!failure) return registered.host;
    failures.push(failure);
  } else {
    const installFailure = runAutopg(bin, ["install"]);
    if (installFailure) {
      failures.push(`autopg install: ${installFailure}`);
    } else {
      const attached = await attachLiveHost(bin, HOST_READY_MS);
      if (attached) return attached;
      failures.push(`autopg install: no listener within ${HOST_READY_MS}ms`);
    }
  }

  const where =
    registered != null
      ? `autopg host is registered on 127.0.0.1:${registered.host.port} but nothing is listening.\n`
      : "";
  throw new Error(formatHostStartError(`${where}${failures.join("\n")}`));
}

/**
 * Ephemeral host owned by this process/job: detached `autopg postmaster` with
 * fully ignored stdio (caller exit must not close pipes under the daemon).
 *
 * Never runs `autopg install` — that rewrites `~/.autopg/admin.json` and fails
 * with `supervisor mismatch` next to a local pm2 install. Reuses a listener
 * already on the recipe port. Concurrent cold starts (Nx running several
 * `db:ready` on one runner) serialize on {@link tryColdStartLock}: only the
 * holder prunes and starts; everyone else waits for the listener.
 */
export async function startEphemeralHost(
  bin: string,
  recipe: EphemeralHostRecipe = ephemeralHostRecipe(),
): Promise<AutopgDiscovery> {
  const { dataDir, port } = recipe;
  if (await canConnect(port)) return discoveryFromRecipe(bin, recipe);

  const useRamShm = recipe.postmasterArgs.includes("--ram");
  const lockPath = `${dataDir}.lock`;
  const holder = tryColdStartLock(lockPath);
  if (holder == null) {
    try {
      // Re-check under the lock: a peer may have finished starting meanwhile.
      if (!(await canConnect(port)) && liveDataDirOwner(dataDir) == null) {
        await coldStartEphemeral(bin, recipe, useRamShm);
      }
    } finally {
      rmSync(lockPath, { force: true });
    }
  }

  if (await waitForListener({ port, readyMs: HOST_READY_MS })) {
    return discoveryFromRecipe(bin, recipe);
  }
  const owner =
    holder != null
      ? `cold start pid ${holder}`
      : `postmaster pid ${liveDataDirOwner(dataDir) ?? "?"}`;
  throw new Error(
    formatHostStartError(
      `${owner} owns ${dataDir} but did not accept 127.0.0.1:${port} within ${HOST_READY_MS}ms`,
      useRamShm,
    ),
  );
}

/** Prune our dead leftover data dir and start the postmaster. Caller holds the cold-start lock. */
async function coldStartEphemeral(
  bin: string,
  recipe: EphemeralHostRecipe,
  useRamShm: boolean,
): Promise<void> {
  // Locked, no listener, no live postmaster.pid: the data dir is a dead run's leftover.
  // Only this cedar-pg-owned path: `/dev/shm/PostgreSQL.*` / `pgserve-*` belong to
  // every Postgres on the machine (the registered host included) and are never touched.
  rmSync(recipe.dataDir, { recursive: true, force: true });

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

  try {
    await spawnDetachedPostmaster({
      bin,
      args: recipe.postmasterArgs,
      port: recipe.port,
      readyMs: HOST_READY_MS,
    });
  } catch (err) {
    // A lockless starter (older cedar-pg) won the data dir → caller waits for it.
    if (liveDataDirOwner(recipe.dataDir) != null) return;
    throw new Error(formatHostStartError(errorDetail(err), useRamShm));
  }
}

let autopgVersionChecked = false;

/** Once per process: warn (never fail, never upgrade) when autopg is older than the pin. */
function warnIfAutopgOutdated(bin: string): void {
  if (autopgVersionChecked) return;
  autopgVersionChecked = true;
  const warning = outdatedAutopgWarning(readAutopgVersion(bin));
  if (warning) process.stderr.write(warning);
}

/**
 * Attach to a listening autopg host, else start one per
 * {@link resolveHostStartPolicy}. Internal: callers use `acquire` / `adminUrl`.
 */
export async function ensureHostRunning(bin = requireAutopgBin()): Promise<AutopgDiscovery> {
  warnIfAutopgOutdated(bin);
  let registered: AutopgRegistration | null = null;
  try {
    registered = discoverRegistration(bin);
  } catch {
    // no registration — local recovery may `install`
  }
  if (registered && (await waitForListener({ port: registered.host.port }))) {
    return registered.host;
  }

  return resolveHostStartPolicy() === "ephemeral"
    ? startEphemeralHost(bin)
    : startLocalHost(bin, registered);
}
