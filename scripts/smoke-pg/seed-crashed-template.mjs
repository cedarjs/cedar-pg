/**
 * Simulate a crashed TEMPLATE run: migrated + marked TEMPLATE holding a stale
 * row, a leftover worker clone `_c_1`, no dispose, and no lease file. The next
 * template globalSetup must clear all of it before migrate.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { STATE_DIRNAME, acquire, cloneFromTemplate, markTemplate } from "@cedarjs/pg";

const acquired = await acquire({ mode: "test", setEnv: false });
const client = new pg.Client({ connectionString: acquired.databaseUrl });
await client.connect();
try {
  await client.query("CREATE TABLE smoke_marker (file text PRIMARY KEY)");
  await client.query("INSERT INTO smoke_marker (file) VALUES ('stale')");
} finally {
  await client.end();
}
const { root, adminUrl } = acquired;
await markTemplate({ root, mode: "test", adminUrl });
await cloneFromTemplate({ root, mode: "test", adminUrl, name: "1" });
rmSync(join(root, STATE_DIRNAME), { recursive: true, force: true });
console.log(`seeded crashed TEMPLATE run: ${acquired.databaseName} (+ _c_1, no lease)`);
