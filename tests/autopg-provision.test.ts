import { expect, test, vi } from "vite-plus/test";

test("provisions main and shadow on one connection, reuses them, and drops only role-owned DBs", async () => {
  const roleName = "cpg_dev_role";
  const names = ["cpg_dev", "cpg_dev_shadow"];
  const databases = new Map([["unrelated", "other_role"]]);
  const statements: string[] = [];
  let connections = 0;
  let roleExists = false;
  class Client {
    async connect(): Promise<void> {
      connections++;
    }
    async end(): Promise<void> {}
    async query(sql: string, params: string[] = []) {
      statements.push(sql);
      if (sql.startsWith("SELECT 1 FROM pg_roles WHERE rolname")) {
        return { rowCount: roleExists ? 1 : 0, rows: [] };
      }
      if (sql.startsWith("CREATE ROLE")) {
        roleExists = true;
        return { rows: [] };
      }
      if (sql.includes("SELECT 1 FROM pg_database")) {
        return { rowCount: databases.has(params[0]!) ? 1 : 0, rows: [] };
      }
      const create = /^CREATE DATABASE "([^"]+)" OWNER "([^"]+)"$/.exec(sql);
      if (create) {
        if (databases.has(create[1]!)) throw new Error("database already exists");
        databases.set(create[1]!, create[2]!);
        return { rows: [] };
      }
      if (sql.includes("SELECT datname FROM pg_database")) {
        return {
          rows: [...databases]
            .filter(([, owner]) => owner === params[0])
            .map(([datname]) => ({ datname })),
        };
      }
      if (sql.includes("SELECT datistemplate")) {
        return { rowCount: databases.has(params[0]!) ? 1 : 0, rows: [{ datistemplate: false }] };
      }
      const drop = /^DROP DATABASE IF EXISTS "([^"]+)"$/.exec(sql);
      if (drop) {
        databases.delete(drop[1]!);
        return { rows: [] };
      }
      if (
        /^(ALTER ROLE|ALTER DATABASE|DROP ROLE)/.test(sql) ||
        sql.includes("pg_terminate_backend")
      ) {
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }
  }
  vi.resetModules();
  vi.doMock("pg", () => ({ default: { Client } }));
  try {
    const { ensureDatabases, dropDatabasesOwnedByRole } =
      await import("../src/providers/autopg.ts");
    const adminUrl = "postgresql://postgres@127.0.0.1:5432/postgres";
    await ensureDatabases({ adminUrl, databaseNames: names, roleName });
    expect(connections).toBe(1);
    expect(names.map((name) => databases.get(name))).toEqual([roleName, roleName]);
    await ensureDatabases({ adminUrl, databaseNames: names, roleName });
    expect(connections).toBe(2);
    expect(statements.filter((sql) => sql.startsWith("CREATE DATABASE"))).toHaveLength(2);
    expect(statements.filter((sql) => sql.startsWith("CREATE ROLE"))).toHaveLength(1);
    expect(statements.some((sql) => sql.includes("CREATEDB"))).toBe(false);
    await expect(
      dropDatabasesOwnedByRole({ adminUrl, roleName, preferLast: names[0] }),
    ).resolves.toEqual([names[1], names[0]]);
    expect([...databases]).toEqual([["unrelated", "other_role"]]);
    expect(statements.at(-1)).toBe(`DROP ROLE IF EXISTS "${roleName}"`);
  } finally {
    vi.doUnmock("pg");
    vi.resetModules();
  }
});
