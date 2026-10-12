import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { acquire, dispose, gc, loadDevEnv } from "@cedarjs/pg";

// A long worktree name exercises shadow-name truncation against real Postgres.
const root = mkdtempSync(join(tmpdir(), "cedar-pg-shadow-long-worktree-name-"));
const registry = mkdtempSync(join(tmpdir(), "cedar-pg-shadow-registry-"));
process.env.CEDAR_PG_REGISTRY_DIR = registry;
const cli = join(process.cwd(), "node_modules/@cedarjs/pg/dist/cli.mjs");
let lease;
let admin;

function runCli(args, env = process.env) {
  const result = spawnSync("node", [cli, ...args], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function runPrisma(args, env, attach = false) {
  runCli(
    [
      "run",
      ...(attach ? ["--attach"] : []),
      "--root",
      root,
      "--mode=dev",
      "--",
      "node",
      "node_modules/prisma/build/index.js",
      "migrate",
      ...args,
    ],
    env,
  );
}

async function queryDatabase(url, sql) {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

async function owned() {
  const { rows } = await admin.query(
    "SELECT datname FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = $1)",
    [lease.roleName],
  );
  return rows.map(({ datname }) => datname).sort();
}

try {
  lease = await acquire({ root, mode: "dev", setEnv: false });
  const shadow = new URL(lease.shadowDatabaseUrl);
  assert.notEqual(lease.databaseUrl, lease.shadowDatabaseUrl);
  assert.ok(shadow.pathname.endsWith("_dev_" + lease.pathHash + "_shadow"));
  assert.ok(shadow.pathname.slice(1).length <= 63);
  const expectedNames = [lease.databaseName, shadow.pathname.slice(1)].sort();
  admin = new pg.Client({ connectionString: lease.adminUrl });
  await admin.connect();
  assert.deepEqual(await owned(), expectedNames);
  const { rows: roles } = await admin.query("SELECT rolcreatedb FROM pg_roles WHERE rolname = $1", [
    lease.roleName,
  ]);
  assert.equal(roles[0].rolcreatedb, false);

  // Re-acquire must preserve data in both databases, including an upgraded lease.
  for (const url of [lease.databaseUrl, lease.shadowDatabaseUrl]) {
    await queryDatabase(url, "CREATE TABLE retained (id integer)");
  }
  delete process.env.SHADOW_DATABASE_URL;
  loadDevEnv({ root, overwrite: true });
  assert.equal(process.env.SHADOW_DATABASE_URL, lease.shadowDatabaseUrl);
  assert.equal(process.env.DATABASE_URL, lease.databaseUrl);
  const reused = await acquire({ root, mode: "dev", setEnv: false });
  assert.equal(reused.shadowDatabaseUrl, lease.shadowDatabaseUrl);
  for (const url of [reused.databaseUrl, reused.shadowDatabaseUrl]) {
    await queryDatabase(url, "SELECT * FROM retained");
  }

  const checks = [
    "node",
    "-e",
    "const assert = require('node:assert/strict'); assert.equal(process.env.DATABASE_URL, process.env.EXPECT_MAIN); assert.equal(process.env.SHADOW_DATABASE_URL, process.env.EXPECT_SHADOW)",
  ];
  const env = {
    ...process.env,
    DATABASE_URL: "ambient-main",
    SHADOW_DATABASE_URL: "ambient-shadow",
    EXPECT_MAIN: lease.databaseUrl,
    EXPECT_SHADOW: lease.shadowDatabaseUrl,
  };
  for (const flags of [[], ["--attach"]]) {
    runCli(["run", ...flags, "--root", root, "--mode=dev", "--", ...checks], env);
  }
  const json = JSON.parse(runCli(["acquire", "--root", root, "--mode=dev", "--json"]));
  assert.equal(json.shadowDatabaseUrl, lease.shadowDatabaseUrl);
  const printed = runCli(["acquire", "--root", root, "--mode=dev", "--print-env"]);
  assert.equal(printed, readFileSync(join(root, ".cedarpg/dev.env"), "utf8"));

  lease = await acquire({ root, mode: "dev", fresh: true, setEnv: false });
  assert.deepEqual(await owned(), expectedNames);
  for (const url of [lease.databaseUrl, lease.shadowDatabaseUrl]) {
    const { rows } = await queryDatabase(
      url,
      "SELECT to_regclass('public.retained') AS table_name",
    );
    assert.equal(rows[0].table_name, null);
  }

  // Prisma config opts in exactly as documented; no CREATEDB grant is needed.
  writeFileSync(
    join(process.cwd(), "prisma.config.ts"),
    `import { defineConfig, env } from "prisma/config";
export default defineConfig({ schema: "shadow.prisma", migrations: { path: "shadow-migrations" }, datasource: { url: env("DATABASE_URL"), shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } });\n`,
  );
  writeFileSync(
    join(process.cwd(), "shadow.prisma"),
    `datasource db {\n  provider = "postgresql"\n}\nmodel ShadowSmoke {\n  id Int @id @default(autoincrement())\n}\n`,
  );
  runPrisma(["dev", "--create-only", "--name", "init"], { ...env, CI: "" });
  // Deploy then diff a second migration so Prisma replays history in the shadow.
  runPrisma(["deploy"], env, true);
  writeFileSync(
    join(process.cwd(), "shadow.prisma"),
    `datasource db {\n  provider = "postgresql"\n}\nmodel ShadowSmoke {\n  id Int @id @default(autoincrement())\n  label String?\n}\n`,
  );
  runPrisma(["dev", "--create-only", "--name", "label"], { ...env, CI: "" }, true);

  const dropped = await dispose({ root, mode: "dev" });
  assert.equal(dropped.dropped, true);
  assert.deepEqual(dropped.droppedDatabases.sort(), expectedNames);
  assert.deepEqual(await owned(), []);
  lease = await acquire({ root, mode: "dev", setEnv: false });
  rmSync(root, { recursive: true, force: true });
  const collected = await gc();
  assert.deepEqual(collected.dropped.sort(), expectedNames);
  assert.deepEqual(await owned(), []);
  console.log("dev shadow: PASS (reuse, URLs, Prisma migrate dev, fresh, dispose, GC)");
} finally {
  if (lease) {
    if (existsSync(root)) await dispose({ root, mode: "dev" });
    else await gc();
  }
  await admin?.end();
  rmSync(root, { recursive: true, force: true });
  rmSync(registry, { recursive: true, force: true });
}
