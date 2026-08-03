import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { PASSWORD_SALT_PREFIX } from "../core/constants.ts";

export type AutopgDiscovery = {
  port: number;
  adminUrl: string;
  bin: string;
};

/** How cedar-pg starts an autopg host when none is already live. */
export type HostStartPolicy = "local" | "ephemeral";

/** Opinionated install + postmaster argv for CI / ephemeral runners. */
export type EphemeralHostRecipe = {
  dataDir: string;
  ram: boolean;
  installArgs: string[];
  postmasterArgs: string[];
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
 * Fixed CI recipe: `install --no-pm2 --no-ui --data DIR` + detached
 * `postmaster` (`--ram` + `/dev/shm/cedar-pg-<uid>` on Linux when shm exists).
 */
export function ephemeralHostRecipe(opts?: {
  platform?: NodeJS.Platform;
  shmAvailable?: boolean;
  tmpDir?: string;
  uid?: number;
}): EphemeralHostRecipe {
  const platform = opts?.platform ?? process.platform;
  const shmAvailable = opts?.shmAvailable ?? (platform === "linux" && existsSync("/dev/shm"));
  const uid = opts?.uid ?? process.getuid?.() ?? 0;
  const ram = platform === "linux" && shmAvailable;
  const dataDir = ram
    ? `/dev/shm/cedar-pg-${uid}`
    : join(opts?.tmpDir ?? tmpdir(), "cedar-pg-host");

  const installArgs = ["install", "--no-pm2", "--no-ui", "--data", dataDir];
  const postmasterArgs = ram
    ? ["postmaster", "--ram", "--socket-dir", dataDir]
    : ["postmaster", "--socket-dir", dataDir, "--data", dataDir];

  return { dataDir, ram, installArgs, postmasterArgs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startOwnedPostmaster(
  bin: string,
  postmasterArgs: string[],
): {
  child: ChildProcess;
  getStderr: () => string;
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
} {
  let stderr = "";
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const child = spawn(bin, postmasterArgs, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });
  return {
    child,
    getStderr: () => stderr,
    getExit: () => exit,
  };
}

async function waitForOwnedHost(
  bin: string,
  started: ReturnType<typeof startOwnedPostmaster>,
  timeoutMs = OWNED_POSTMASTER_READY_MS,
): Promise<AutopgDiscovery> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "host not ready";
  while (Date.now() < deadline) {
    const exited = started.getExit();
    if (exited) {
      throw new Error(
        `autopg postmaster exited before ready (code=${exited.code}, signal=${exited.signal}).\n` +
          `${started.getStderr()}\n${INSTALL_HINT}`,
      );
    }
    try {
      const discovery = discoverHost(bin);
      started.child.unref();
      return discovery;
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
      await sleep(OWNED_POSTMASTER_POLL_MS);
    }
  }
  started.child.unref();
  throw new Error(
    `Timed out waiting for autopg host after ${timeoutMs}ms.\n${lastDetail}\n${INSTALL_HINT}`,
  );
}

function runInstall(bin: string, args: string[]): void {
  const install = spawnSync(bin, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (install.status !== 0) {
    throw new Error(
      `Failed to start autopg host (exit ${install.status}).\n` +
        `${install.stderr || install.stdout || ""}\n${INSTALL_HINT}`,
    );
  }
}

/**
 * Ensure the host postmaster is up.
 *
 * - Attaches when `autopg status --json` shows a live host.
 * - Otherwise starts from {@link resolveEphemeralHostPolicy}: local pm2 `install`,
 *   or opinionated ephemeral (`--no-pm2 --no-ui` + detached postmaster).
 * - CI job owns ephemeral postmaster lifetime (no cedar-pg host dispose).
 */
export async function ensureHostRunning(bin = requireAutopgBin()): Promise<AutopgDiscovery> {
  try {
    return discoverHost(bin);
  } catch {
    // status failed — start host per policy
  }

  if (resolveEphemeralHostPolicy() === "ephemeral") {
    const recipe = ephemeralHostRecipe();
    mkdirSync(recipe.dataDir, { recursive: true });
    runInstall(bin, recipe.installArgs);
    const started = startOwnedPostmaster(bin, recipe.postmasterArgs);
    return waitForOwnedHost(bin, started);
  }

  runInstall(bin, ["install"]);
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
