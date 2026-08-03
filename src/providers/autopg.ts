import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { PASSWORD_SALT_PREFIX } from "../core/constants.ts";

export type AutopgDiscovery = {
  port: number;
  adminUrl: string;
  bin: string;
};

/**
 * Options for starting an autopg host when none is already live.
 *
 * Local default: omit options → attach if `autopg status` is live, else
 * `autopg install` (pm2 Tier A).
 *
 * CI / ephemeral: pass `noPm2` + `noUi` (+ optional `ram` / `dataDir` / `port`)
 * so cedar-pg owns a detached `autopg postmaster` instead of ambient pm2.
 */
export type EnsureHostOptions = {
  /** Linux: `autopg postmaster --ram` (/dev/shm). Implies owned (non-pm2) lifecycle. */
  ram?: boolean;
  /** Data directory for install / postmaster (e.g. `/dev/shm/autopg-ci`). */
  dataDir?: string;
  /** Skip pm2 registration (Tier B / CI). Starts a detached postmaster. */
  noPm2?: boolean;
  /** Skip the autopg UI process (`--no-ui`). */
  noUi?: boolean;
  /** TCP port for Postgres. */
  port?: number;
  /** Override autopg binary path (same as passing a string to `ensureHostRunning`). */
  bin?: string;
};

/** How long to wait for a freshly spawned postmaster to become discoverable. */
const OWNED_POSTMASTER_READY_MS = 30_000;
const OWNED_POSTMASTER_POLL_MS = 200;

export const INSTALL_HINT =
  "autopg is required. Install with:\n" +
  "  curl -fsSL https://raw.githubusercontent.com/automagik-dev/autopg/main/install.sh | bash\n" +
  "Then ensure ~/.local/bin is on PATH, or set AUTOPG_BIN.";

/** Password scheme v1: sha256(PASSWORD_SALT_PREFIX + "\\0" + databaseName) hex[:32]. Frozen for URL rebuild. */
export const ROLE_PASSWORD_SCHEME = "v1" as const;

function candidateBins(): string[] {
  const out: string[] = [];
  if (process.env.AUTOPG_BIN) out.push(process.env.AUTOPG_BIN);
  out.push("autopg");
  out.push(join(homedir(), ".local", "bin", "autopg"));
  return out;
}

export function resolveAutopgBin(): string | null {
  for (const bin of candidateBins()) {
    if (bin === "autopg") {
      const which = spawnSync("which", ["autopg"], { encoding: "utf8" });
      if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
      continue;
    }
    if (existsSync(bin)) return bin;
  }
  return null;
}

export function requireAutopgBin(): string {
  const bin = resolveAutopgBin();
  if (!bin) {
    throw new Error(INSTALL_HINT);
  }
  return bin;
}

/**
 * Parse `autopg status --json` output. Requires a numeric port and running !== false.
 */
export function parseHostStatus(json: string): { port: number } {
  let parsed: { port?: unknown; running?: unknown };
  try {
    parsed = JSON.parse(json) as { port?: unknown; running?: unknown };
  } catch {
    throw new Error(`autopg status --json returned invalid JSON.\n${INSTALL_HINT}`);
  }
  if (typeof parsed.port !== "number") {
    throw new Error(`autopg status --json missing numeric port.\n${INSTALL_HINT}`);
  }
  if (parsed.running === false) {
    throw new Error(`autopg host is not running.\n${INSTALL_HINT}`);
  }
  return { port: parsed.port };
}

function adminUrlFor(port: number): string {
  return `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
}

/**
 * Discover a live autopg host via `autopg status --json`. Throws if the host is not proven live.
 */
export function discoverHost(bin = requireAutopgBin()): AutopgDiscovery {
  let status: string;
  try {
    status = execFileSync(bin, ["status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to query autopg status.\n${detail}\n${INSTALL_HINT}`);
  }
  const { port } = parseHostStatus(status);
  return { port, adminUrl: adminUrlFor(port), bin };
}

function normalizeEnsureHostOptions(
  optionsOrBin: EnsureHostOptions | string = {},
): EnsureHostOptions {
  if (typeof optionsOrBin === "string") return { bin: optionsOrBin };
  return optionsOrBin;
}

/** True when cedar-pg must own a detached postmaster (not pm2). */
export function usesOwnedPostmaster(opts: EnsureHostOptions): boolean {
  return Boolean(opts.noPm2 || opts.ram);
}

/** `autopg install` argv for the given options (excluding the binary). */
export function installArgsFor(opts: EnsureHostOptions): string[] {
  const args = ["install"];
  if (usesOwnedPostmaster(opts)) args.push("--no-pm2");
  if (opts.noUi) args.push("--no-ui");
  if (opts.port != null) args.push("--port", String(opts.port));
  if (opts.dataDir) args.push("--data", opts.dataDir);
  return args;
}

/**
 * `autopg postmaster` argv for owned (non-pm2) starts.
 * Matches the supported CI recipe: `--ram` + `--socket-dir` when `dataDir` is set.
 */
export function postmasterArgsFor(opts: EnsureHostOptions): string[] {
  const args = ["postmaster"];
  if (opts.ram) args.push("--ram");
  if (opts.port != null) args.push("--port", String(opts.port));
  if (opts.dataDir) {
    args.push("--socket-dir", opts.dataDir);
    if (!opts.ram) args.push("--data", opts.dataDir);
  }
  return args;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function startOwnedPostmaster(bin: string, opts: EnsureHostOptions): void {
  const child = spawn(bin, postmasterArgsFor(opts), {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function waitForHost(bin: string, timeoutMs = OWNED_POSTMASTER_READY_MS): AutopgDiscovery {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "host not ready";
  while (Date.now() < deadline) {
    try {
      return discoverHost(bin);
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
      sleepSync(OWNED_POSTMASTER_POLL_MS);
    }
  }
  throw new Error(
    `Timed out waiting for autopg host after ${timeoutMs}ms.\n${lastDetail}\n${INSTALL_HINT}`,
  );
}

/**
 * Ensure the host postmaster is up.
 *
 * - Attaches when `autopg status --json` shows a live host (options are ignored).
 * - Otherwise starts with the given options: bare `autopg install` (pm2) by default,
 *   or `install --no-pm2 …` + detached `postmaster` when `noPm2` / `ram` is set.
 *
 * Accepts either an options object or a binary path string (legacy).
 */
export function ensureHostRunning(optionsOrBin: EnsureHostOptions | string = {}): AutopgDiscovery {
  const opts = normalizeEnsureHostOptions(optionsOrBin);
  const bin = opts.bin ?? requireAutopgBin();

  try {
    return discoverHost(bin);
  } catch {
    // status failed — start host with the requested options
  }

  const install = spawnSync(bin, installArgsFor(opts), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (install.status !== 0) {
    throw new Error(
      `Failed to start autopg host (exit ${install.status}).\n` +
        `${install.stderr || install.stdout || ""}\n${INSTALL_HINT}`,
    );
  }

  if (usesOwnedPostmaster(opts)) {
    startOwnedPostmaster(bin, opts);
    return waitForHost(bin);
  }

  return discoverHost(bin);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Deterministic local-only password for an app role (Prisma/TCP need it;
 * autopg hba uses `password` for 127.0.0.1).
 */
export function rolePasswordFor(databaseName: string): string {
  return createHash("sha256")
    .update(`${PASSWORD_SALT_PREFIX}\0${databaseName}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Idempotently CREATE ROLE + CREATE DATABASE with cedar-pg owned names.
 */
export async function ensureDatabase(opts: {
  adminUrl: string;
  databaseName: string;
  roleName: string;
  password?: string;
}): Promise<void> {
  const password = opts.password ?? rolePasswordFor(opts.databaseName);
  const client = new pg.Client({ connectionString: opts.adminUrl });
  await client.connect();
  try {
    const roleExists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
      opts.roleName,
    ]);
    if (roleExists.rowCount === 0) {
      await client.query(
        `CREATE ROLE ${quoteIdent(opts.roleName)} WITH LOGIN PASSWORD ${quoteLiteral(password)}`,
      );
    } else {
      await client.query(
        `ALTER ROLE ${quoteIdent(opts.roleName)} WITH LOGIN PASSWORD ${quoteLiteral(password)}`,
      );
    }

    const dbExists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      opts.databaseName,
    ]);
    if (dbExists.rowCount === 0) {
      await client.query(
        `CREATE DATABASE ${quoteIdent(opts.databaseName)} OWNER ${quoteIdent(opts.roleName)}`,
      );
    } else {
      await client.query(
        `ALTER DATABASE ${quoteIdent(opts.databaseName)} OWNER TO ${quoteIdent(opts.roleName)}`,
      );
    }
  } finally {
    await client.end();
  }
}

/**
 * DROP DATABASE (force terminate backends) + DROP ROLE.
 */
export async function dropDatabase(opts: {
  adminUrl: string;
  databaseName: string;
  roleName: string;
}): Promise<void> {
  const client = new pg.Client({ connectionString: opts.adminUrl });
  await client.connect();
  try {
    await client.query(
      `
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
      `,
      [opts.databaseName],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(opts.databaseName)}`);
    const owns = await client.query(
      `SELECT 1 FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = $1) LIMIT 1`,
      [opts.roleName],
    );
    if (owns.rowCount === 0) {
      await client.query(`DROP ROLE IF EXISTS ${quoteIdent(opts.roleName)}`);
    }
  } finally {
    await client.end();
  }
}

export function buildDatabaseUrl(opts: {
  port: number;
  databaseName: string;
  roleName: string;
  password?: string;
}): string {
  const password = opts.password ?? rolePasswordFor(opts.databaseName);
  const user = encodeURIComponent(opts.roleName);
  const pass = encodeURIComponent(password);
  return `postgresql://${user}:${pass}@127.0.0.1:${opts.port}/${opts.databaseName}`;
}
