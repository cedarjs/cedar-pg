const path = require("node:path");
const { Client } = require("pg");
const { cloneWorkerDatabase } = require("@cedarjs/pg/jest/template");

// smoke-pg.mjs copies this file, so two test files share worker 1 (--runInBand).
const file = path.basename(__filename);

beforeAll(() => cloneWorkerDatabase());

test(`${file}: runs on the reused worker clone, not crashed-run leftovers`, async () => {
  const url = process.env.DATABASE_URL;
  expect(url).toMatch(/\/cpg_.*_c_1$/);
  expect(process.env.TEST_DATABASE_URL).toBe(url);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("INSERT INTO smoke_marker (file) VALUES ($1)", [file]);
    const { rows } = await client.query("SELECT file FROM smoke_marker");
    const files = rows.map((r) => r.file);
    expect(files).toContain(file);
    expect(files).not.toContain("stale");
  } finally {
    await client.end();
  }
});
