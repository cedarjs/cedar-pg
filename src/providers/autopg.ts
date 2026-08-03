import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
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

export const INSTALL_HINT =
  "autopg is required. Install with:\n" +
  "  curl -fsSL https://raw.githubusercontent.com/automagik-dev/autopg/main/install.sh | bash\n" +
  "Then ensure ~/.local/bin is on PATH, or set AUTOPG_BIN.";

/** Password scheme v2: sha256(PASSWORD_SALT_PREFIX + "\\0" + roleName) hex[:32]. Frozen for URL rebuild. */
export const ROLE_PASSWORD_SCHEME = "v2" as const;

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

/**
 * Admin URL for an autopg host on `port`.
 *
 * Credentials follow autopg's own defaults / env chain (not "any local Postgres"):
 * - user: `AUTOPG_PG_USER` / `PGSERVE_PG_USER` / `postgres`
 * - password: `AUTOPG_PG_PASSWORD` / `PGSERVE_PG_PASSWORD` / `postgres`
 *
 * Port is never scanned: callers pass the port from `autopg status` (attach) or the
 * ephemeral recipe (`55432`). That keeps us off unrelated local servers (e.g. brew on 5432).
 */
export function adminUrlFor(port: number, env: NodeJS.ProcessEnv = process.env): string {
  const user = encodeURIComponent(env.AUTOPG_PG_USER || env.PGSERVE_PG_USER || "postgres");
  const password = encodeURIComponent(
    env.AUTOPG_PG_PASSWORD || env.PGSERVE_PG_PASSWORD || "postgres",
  );
  return `postgresql://${user}:${password}@127.0.0.1:${port}/postgres`;
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

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function withAdminClient<T>(
  adminUrl: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Deterministic local-only password for an app role (Prisma/TCP need it;
 * autopg hba uses `password` for 127.0.0.1).
 *
 * Keyed by `roleName` (not databaseName) so TEMPLATE clones that reuse the
 * same role keep working when `buildDatabaseUrl` is called with a new database.
 */
export function rolePasswordFor(roleName: string): string {
  return createHash("sha256")
    .update(`${PASSWORD_SALT_PREFIX}\0${roleName}`)
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
  const password = opts.password ?? rolePasswordFor(opts.roleName);
  await withAdminClient(opts.adminUrl, async (client) => {
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
  });
}

/**
 * Mark (or unmark) a database as a PostgreSQL template (`IS_TEMPLATE`).
 * Template DBs cannot be dropped until unset.
 */
export async function setDatabaseIsTemplate(opts: {
  adminUrl: string;
  databaseName: string;
  isTemplate: boolean;
}): Promise<void> {
  const flag = opts.isTemplate ? "true" : "false";
  await withAdminClient(opts.adminUrl, async (client) => {
    await client.query(`ALTER DATABASE ${quoteIdent(opts.databaseName)} WITH IS_TEMPLATE ${flag}`);
  });
}

/**
 * CREATE DATABASE … TEMPLATE … OWNER via admin connection.
 * Test roles are LOGIN-only; workers cannot CREATE DATABASE themselves.
 */
export async function cloneDatabaseFromTemplate(opts: {
  adminUrl: string;
  templateName: string;
  databaseName: string;
  roleName: string;
}): Promise<void> {
  await withAdminClient(opts.adminUrl, async (client) => {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      opts.databaseName,
    ]);
    if (exists.rowCount && exists.rowCount > 0) {
      throw new Error(`database already exists: ${opts.databaseName}`);
    }
    await client.query(
      `CREATE DATABASE ${quoteIdent(opts.databaseName)} WITH TEMPLATE ${quoteIdent(opts.templateName)} OWNER ${quoteIdent(opts.roleName)}`,
    );
  });
}

/** Datnames owned by role (for dispose/GC of TEMPLATE clones). */
export async function listDatabasesOwnedByRole(opts: {
  adminUrl: string;
  roleName: string;
}): Promise<string[]> {
  return withAdminClient(opts.adminUrl, async (client) => {
    const result = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database
       WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = $1)
       ORDER BY datname`,
      [opts.roleName],
    );
    return result.rows.map((r) => r.datname);
  });
}

/**
 * DROP DATABASE (unset IS_TEMPLATE, force terminate backends) + DROP ROLE
 * when the role owns no remaining databases.
 */
export async function dropDatabase(opts: {
  adminUrl: string;
  databaseName: string;
  roleName: string;
}): Promise<void> {
  await withAdminClient(opts.adminUrl, async (client) => {
    const db = await client.query<{ datistemplate: boolean }>(
      `SELECT datistemplate FROM pg_database WHERE datname = $1`,
      [opts.databaseName],
    );
    if (db.rowCount && db.rowCount > 0) {
      if (db.rows[0]?.datistemplate) {
        await client.query(
          `ALTER DATABASE ${quoteIdent(opts.databaseName)} WITH IS_TEMPLATE false`,
        );
      }
      await client.query(
        `
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()
        `,
        [opts.databaseName],
      );
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(opts.databaseName)}`);
    }
    const owns = await client.query(
      `SELECT 1 FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = $1) LIMIT 1`,
      [opts.roleName],
    );
    if (owns.rowCount === 0) {
      await client.query(`DROP ROLE IF EXISTS ${quoteIdent(opts.roleName)}`);
    }
  });
}

export function buildDatabaseUrl(opts: {
  port: number;
  databaseName: string;
  roleName: string;
  password?: string;
}): string {
  const password = opts.password ?? rolePasswordFor(opts.roleName);
  const user = encodeURIComponent(opts.roleName);
  const pass = encodeURIComponent(password);
  return `postgresql://${user}:${pass}@127.0.0.1:${opts.port}/${opts.databaseName}`;
}
