const { Client } = require("pg");
const { createGlobalSetup } = require("@cedarjs/pg/jest/template");

// Plain CREATE TABLE (no IF NOT EXISTS): fails if setup kept a crashed run's TEMPLATE.
module.exports = createGlobalSetup({
  migrate: async ({ databaseUrl }) => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query("CREATE TABLE smoke_marker (file text PRIMARY KEY)");
    } finally {
      await client.end();
    }
  },
});
