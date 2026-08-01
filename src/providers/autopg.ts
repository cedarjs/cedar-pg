import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";

export type AutopgDiscovery = {
  port: number;
  socketDir: string | null;
  adminUrl: string;
  bin: string;
};

const INSTALL_HINT =
  "autopg is required. Install with:\n" +
  "  curl -fsSL https://raw.githubusercontent.com/automagik-dev/autopg/main/install.sh | bash\n" +
  "Then ensure ~/.local/bin is on PATH, or set AUTOPG_BIN.";

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

function readAdminJson(): { port?: number; socketDir?: string } | null {
  const configDir =
    process.env.AUTOPG_CONFIG_DIR || process.env.PGSERVE_CONFIG_DIR || join(homedir(), ".autopg");
  const file = join(configDir, "admin.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as {
      port?: number;
      socketDir?: string;
    };
  } catch {
    return null;
  }
}

/**
 * Discover a live autopg host. Tries `autopg status --json`, then admin.json.
 */
export function discoverHost(bin = requireAutopgBin()): AutopgDiscovery {
  let port = 5432;
  let socketDir: string | null = null;

  try {
    const status = execFileSync(bin, ["status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(status) as {
      port?: number;
      socketDir?: string;
      running?: boolean;
    };
    if (typeof parsed.port === "number") port = parsed.port;
    if (typeof parsed.socketDir === "string") socketDir = parsed.socketDir;
  } catch {
    const admin = readAdminJson();
    if (admin?.port) port = admin.port;
    if (admin?.socketDir) socketDir = admin.socketDir;
  }

  // Prefer TCP admin URL — works from Node without Unix socket quirks
  const adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  return { port, socketDir, adminUrl, bin };
}

/**
 * Ensure the host postmaster is up. Runs `autopg install` when status fails.
 */
export function ensureHostRunning(bin = requireAutopgBin()): AutopgDiscovery {
  try {
    return discoverHost(bin);
  } catch {
    // fall through to install
  }

  const install = spawnSync(bin, ["install"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (install.status !== 0) {
    // Maybe binary exists but isn't the full CLI — try install.sh hint
    throw new Error(
      `Failed to start autopg host (exit ${install.status}).\n` +
        `${install.stderr || install.stdout || ""}\n${INSTALL_HINT}`,
    );
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
  return createHash("sha256").update(`cedar-pg\0${databaseName}`).digest("hex").slice(0, 32);
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
      // Ensure ownership if DB already exists
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
    // Drop role only if it owns nothing else
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
  socketDir?: string | null;
}): string {
  // Prefer TCP with a deterministic password — Prisma and node-pg both handle
  // this reliably. (Unix-socket URLs with empty authority break Prisma.)
  const password = opts.password ?? rolePasswordFor(opts.databaseName);
  const user = encodeURIComponent(opts.roleName);
  const pass = encodeURIComponent(password);
  return `postgresql://${user}:${pass}@127.0.0.1:${opts.port}/${opts.databaseName}`;
}

export { INSTALL_HINT };
