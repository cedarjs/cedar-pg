const path = require("node:path");
const { Client } = require("pg");
const { cloneWorkerDatabase } = require("@cedarjs/pg/jest/template");

// smoke-pg.mjs copies this file, so two test files share worker 1 (--runInBand).
const file = path.basename(__filename);

beforeAll(() => cloneWorkerDatabase());

// Each file starts empty with sequences restarted, even on the reused clone:
// the second file sees id 1 and no row from the first (TRUNCATE … RESTART IDENTITY).
test(`${file}: runs on a reset reused worker clone, not crashed-run leftovers`, async () => {
  const url = process.env.DATABASE_URL;
  expect(url).toMatch(/\/cpg_.*_c_1$/);
  expect(process.env.TEST_DATABASE_URL).toBe(url);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("INSERT INTO smoke_marker (file) VALUES ($1)", [file]);
    const { rows } = await client.query("SELECT id, file FROM smoke_marker");
    expect(rows).toEqual([{ id: 1, file }]);
  } finally {
    await client.end();
  }
});
