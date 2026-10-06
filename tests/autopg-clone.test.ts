import { expect, test, vi } from "vite-plus/test";

type FakeDb = { datistemplate: boolean; owner: string };

/**
 * Scripted `pg.Client`: answers the three statements `cloneDatabaseFromTemplate`
 * issues against an in-memory pg_database. CREATE raises `42P04` like Postgres.
 */
function fakePg(databases: Map<string, FakeDb>) {
  const statements: string[] = [];
  class Client {
    async connect(): Promise<void> {}
    async end(): Promise<void> {}
    async query(sql: string, params: string[] = []) {
      statements.push(sql);
      if (sql.includes("SELECT datistemplate")) {
        const db = databases.get(params[0]!);
        return { rowCount: db ? 1 : 0, rows: db ? [{ datistemplate: db.datistemplate }] : [] };
      }
      if (sql.includes("pg_get_userbyid")) {
        const db = databases.get(params[0]!);
        return { rowCount: db ? 1 : 0, rows: db ? [{ owner: db.owner }] : [] };
      }
      const create = /^CREATE DATABASE "([^"]+)" WITH TEMPLATE "[^"]+" OWNER "([^"]+)"$/.exec(sql);
      if (create) {
        const [, name, owner] = create;
        if (databases.has(name!)) {
          throw Object.assign(new Error(`database "${name}" already exists`), { code: "42P04" });
        }
        databases.set(name!, { datistemplate: false, owner: owner! });
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }
  }
  return { module: { default: { Client } }, statements };
}

async function withFakePg<T>(
  databases: Map<string, FakeDb>,
  run: (provider: typeof import("../src/providers/autopg.ts"), statements: string[]) => Promise<T>,
): Promise<T> {
  const fake = fakePg(databases);
  vi.resetModules();
  vi.doMock("pg", () => fake.module);
  try {
    return await run(await import("../src/providers/autopg.ts"), fake.statements);
  } finally {
    vi.doUnmock("pg");
    vi.resetModules();
  }
}

const ROLE = "cpg_tmpl_role";
const base = {
  adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
  templateName: "cpg_tmpl",
  databaseName: "cpg_tmpl_c_1",
  roleName: ROLE,
};

function hostWithTemplate(): Map<string, FakeDb> {
  return new Map([["cpg_tmpl", { datistemplate: true, owner: ROLE }]]);
}

test("cloneDatabaseFromTemplate creates once, then reuse keeps the same clone", async () => {
  const databases = hostWithTemplate();
  await withFakePg(databases, async ({ cloneDatabaseFromTemplate }, statements) => {
    await expect(cloneDatabaseFromTemplate({ ...base, reuse: true })).resolves.toBe("created");
    // Second test file in the same worker: CREATE hits 42P04, owner matches → reuse.
    await expect(cloneDatabaseFromTemplate({ ...base, reuse: true })).resolves.toBe("reused");
    expect(statements.filter((s) => s.startsWith("CREATE DATABASE"))).toHaveLength(2);
    expect(databases.get("cpg_tmpl_c_1")).toEqual({ datistemplate: false, owner: ROLE });
  });
});

test("cloneDatabaseFromTemplate without reuse still fails on an existing clone", async () => {
  const databases = hostWithTemplate();
  databases.set("cpg_tmpl_c_1", { datistemplate: false, owner: ROLE });
  await withFakePg(databases, async ({ cloneDatabaseFromTemplate }) => {
    await expect(cloneDatabaseFromTemplate(base)).rejects.toThrow(
      /^database already exists: cpg_tmpl_c_1 \(owned by cpg_tmpl_role\)$/,
    );
  });
});

test("cloneDatabaseFromTemplate never reuses a clone owned by another role", async () => {
  const databases = hostWithTemplate();
  databases.set("cpg_tmpl_c_1", { datistemplate: false, owner: "someone_else" });
  await withFakePg(databases, async ({ cloneDatabaseFromTemplate }) => {
    await expect(cloneDatabaseFromTemplate({ ...base, reuse: true })).rejects.toThrow(
      /database already exists: cpg_tmpl_c_1 \(owned by someone_else\)/,
    );
  });
});

test("cloneDatabaseFromTemplate still requires a marked TEMPLATE", async () => {
  const databases = new Map([["cpg_tmpl", { datistemplate: false, owner: ROLE }]]);
  await withFakePg(databases, async ({ cloneDatabaseFromTemplate }, statements) => {
    await expect(cloneDatabaseFromTemplate({ ...base, reuse: true })).rejects.toThrow(
      /not a TEMPLATE; run markTemplate first/,
    );
    expect(statements.some((s) => s.startsWith("CREATE DATABASE"))).toBe(false);
  });
});
