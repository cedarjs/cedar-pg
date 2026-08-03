const { Client } = require("pg");

test("jest adapter exposes a live DATABASE_URL", async () => {
  const url = process.env.DATABASE_URL;
  expect(url).toBeTruthy();
  expect(url).toMatch(/^postgres(ql)?:\/\//);
  expect(url).toMatch(/\/cpg_/);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query("select 1::int as n");
    expect(rows[0]?.n).toBe(1);
  } finally {
    await client.end();
  }
});
