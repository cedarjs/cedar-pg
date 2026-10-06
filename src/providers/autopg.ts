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

/**
 * Registered host from `autopg status --json`: attach target plus the paths a
 * revive needs. Paths are only what autopg reports — never guessed, because
 * autopg's own defaults depend on env (`AUTOPG_CONFIG_DIR`, `XDG_RUNTIME_DIR`).
 */
export type AutopgRegistration = HostStatusPaths & { host: AutopgDiscovery };

type HostStatusPaths = {
  dataDir?: string;
  socketDir?: string;
  logsDir?: string;
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

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parse `autopg status --json` → the **registered** port (and data/socket/logs
 * dirs when present). Throws only when the output is not autopg status JSON.
 *
 * Registration is not liveness: autopg reports a port for a stopped host too,
 * and its `status` string is supervisor-specific (pm2 `online`, systemd-user /
 * launchd differ). `runtime.live` is also not the attach gate — a bare
 * postmaster can be query-ready while status stays `stopped` / `pid: null`.
 * Liveness is a TCP accept on the port, proven by the caller (`acquire`).
 */
export function parseHostStatus(json: string): HostStatusPaths & { port: number } {
  let parsed: { port?: unknown } & { [K in keyof HostStatusPaths]?: unknown };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    throw new Error(`autopg status --json returned invalid JSON.\n${INSTALL_HINT}`);
  }
  if (typeof parsed.port !== "number") {
    throw new Error(`autopg status --json missing numeric port.\n${INSTALL_HINT}`);
  }
  const result: HostStatusPaths & { port: number } = { port: parsed.port };
  for (const key of ["dataDir", "socketDir", "logsDir"] as const) {
    const value = optionalNonEmptyString(parsed[key]);
    if (value) result[key] = value;
  }
  return result;
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

function readStatusJson(bin: string): string {
  try {
    return execFileSync(bin, ["status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to query autopg status.\n${detail}\n${INSTALL_HINT}`);
  }
}

/**
 * Discover the registered autopg host (attach target + reported data/socket/logs
 * dirs) via `autopg status --json`. Throws when autopg cannot be queried; does
 * **not** prove a listener — probe TCP (or use `acquire`, which does) before connecting.
 */
export function discoverRegistration(bin = requireAutopgBin()): AutopgRegistration {
  const { port, ...paths } = parseHostStatus(readStatusJson(bin));
  return { host: { port, adminUrl: adminUrlFor(port), bin }, ...paths };
}

/**
 * Discover the registered autopg host (port + admin URL) via `autopg status --json`.
 * Throws when autopg cannot be queried; does **not** prove a listener — probe TCP
 * (or use `acquire`, which does) before connecting.
 */
export function discoverHost(bin = requireAutopgBin()): AutopgDiscovery {
  return discoverRegistration(bin).host;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Grace for a postmaster that accepts TCP but still answers 57P03 (startup / recovery). */
const ADMIN_CONNECT_READY_MS = 30_000;
const ADMIN_CONNECT_POLL_MS = 200;

export type ConnectRetryOptions = {
  readyMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Retry `connect` while Postgres answers `57P03` (cannot_connect_now: "the
 * database system is starting up" / in recovery). TCP accept — the host
 * liveness gate — comes before query-ready, so a freshly revived or crash-
 * recovering postmaster needs this. Any other error is thrown immediately.
 */
export async function connectWhileStartingUp<T>(
  connect: () => Promise<T>,
  opts: ConnectRetryOptions = {},
): Promise<T> {
  const now = opts.now ?? Date.now;
  const pause = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.readyMs ?? ADMIN_CONNECT_READY_MS);
  for (;;) {
    try {
      return await connect();
    } catch (err) {
      if ((err as { code?: unknown }).code !== "57P03" || now() >= deadline) throw err;
    }
    await pause(opts.pollMs ?? ADMIN_CONNECT_POLL_MS);
  }
}

async function withAdminClient<T>(
  adminUrl: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  // A pg.Client cannot reconnect after a failed connect — new client per attempt.
  const client = await connectWhileStartingUp(async () => {
    const attempt = new pg.Client({ connectionString: adminUrl });
    try {
      await attempt.connect();
      return attempt;
    } catch (err) {
      await attempt.end().catch(() => {});
      throw err;
    }
  });
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

/** Postgres `duplicate_database`: CREATE DATABASE hit an existing datname. */
const DUPLICATE_DATABASE = "42P04";

export type CloneOutcome = "created" | "reused";

/**
 * CREATE DATABASE … TEMPLATE … OWNER via admin connection.
 * Test roles are LOGIN-only; workers cannot CREATE DATABASE themselves.
 *
 * With `reuse`, an existing `databaseName` owned by `roleName` is kept as-is
 * (`"reused"`) — a worker clone made earlier in this run by another test file.
 * An existing datname owned by any other role always fails: it is not ours.
 */
export async function cloneDatabaseFromTemplate(opts: {
  adminUrl: string;
  templateName: string;
  databaseName: string;
  roleName: string;
  reuse?: boolean;
}): Promise<CloneOutcome> {
  return withAdminClient(opts.adminUrl, async (client): Promise<CloneOutcome> => {
    const tmpl = await client.query<{ datistemplate: boolean }>(
      `SELECT datistemplate FROM pg_database WHERE datname = $1`,
      [opts.templateName],
    );
    if (!tmpl.rowCount) {
      throw new Error(`template database not found: ${opts.templateName}`);
    }
    if (!tmpl.rows[0]?.datistemplate) {
      throw new Error(`database is not a TEMPLATE; run markTemplate first: ${opts.templateName}`);
    }

    try {
      await client.query(
        `CREATE DATABASE ${quoteIdent(opts.databaseName)} WITH TEMPLATE ${quoteIdent(opts.templateName)} OWNER ${quoteIdent(opts.roleName)}`,
      );
      return "created";
    } catch (err) {
      if ((err as { code?: unknown }).code !== DUPLICATE_DATABASE) throw err;
    }
    const existing = await client.query<{ owner: string }>(
      `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1`,
      [opts.databaseName],
    );
    const owner = existing.rows[0]?.owner;
    if (opts.reuse && owner === opts.roleName) return "reused";
    throw new Error(
      `database already exists: ${opts.databaseName} (owned by ${owner ?? "unknown"})`,
    );
  });
}

async function listOwnedDatnames(client: pg.Client, roleName: string): Promise<string[]> {
  const result = await client.query<{ datname: string }>(
    `SELECT datname FROM pg_database
     WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = $1)
     ORDER BY datname`,
    [roleName],
  );
  return result.rows.map((r) => r.datname);
}

/** Unset IS_TEMPLATE if needed, terminate backends, DROP DATABASE (no-op if missing). */
async function dropOneDatabase(client: pg.Client, databaseName: string): Promise<void> {
  const db = await client.query<{ datistemplate: boolean }>(
    `SELECT datistemplate FROM pg_database WHERE datname = $1`,
    [databaseName],
  );
  if (!db.rowCount || db.rowCount === 0) return;
  if (db.rows[0]?.datistemplate) {
    await client.query(`ALTER DATABASE ${quoteIdent(databaseName)} WITH IS_TEMPLATE false`);
  }
  await client.query(
    `
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = $1 AND pid <> pg_backend_pid()
    `,
    [databaseName],
  );
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)}`);
}

/**
 * DROP every database owned by `roleName` on one admin connection, then DROP ROLE.
 * When `preferLast` is owned, it is dropped after the other owned datnames (TEMPLATE after clones).
 * Never invents a DROP target beyond role ownership.
 */
export async function dropDatabasesOwnedByRole(opts: {
  adminUrl: string;
  roleName: string;
  preferLast?: string;
}): Promise<string[]> {
  return withAdminClient(opts.adminUrl, async (client) => {
    const owned = await listOwnedDatnames(client, opts.roleName);
    const ordered = [
      ...owned.filter((name) => name !== opts.preferLast),
      ...owned.filter((name) => name === opts.preferLast),
    ];
    const dropped: string[] = [];
    for (const databaseName of ordered) {
      await dropOneDatabase(client, databaseName);
      dropped.push(databaseName);
    }
    await client.query(`DROP ROLE IF EXISTS ${quoteIdent(opts.roleName)}`);
    return dropped;
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
    await dropOneDatabase(client, opts.databaseName);
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
