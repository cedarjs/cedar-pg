import { expect, test, vi } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
async function withMockedLifecycle<T>(
  mocks: {
    ensureIfNeeded?: ReturnType<typeof vi.fn>;
    markTemplate?: ReturnType<typeof vi.fn>;
    cloneFromTemplate?: ReturnType<typeof vi.fn>;
    dispose?: ReturnType<typeof vi.fn>;
  },
  run: () => Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.doMock("../src/core/lifecycle.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/core/lifecycle.ts")>(
      "../src/core/lifecycle.ts",
    );
    return {
      ...actual,
      ensureIfNeeded: mocks.ensureIfNeeded ?? actual.ensureIfNeeded,
      markTemplate: mocks.markTemplate ?? actual.markTemplate,
      cloneFromTemplate: mocks.cloneFromTemplate ?? actual.cloneFromTemplate,
      dispose: mocks.dispose ?? actual.dispose,
    };
  });
  try {
    return await run();
  } finally {
    vi.doUnmock("../src/core/lifecycle.ts");
    vi.resetModules();
  }
}

test("setupTemplateMode ensures, migrates, then markTemplate", async () => {
  const ensureIfNeeded = vi.fn(async () => ({
    status: "ensured" as const,
    databaseUrl: "postgresql://role:pw@127.0.0.1:5433/cpg_tmpl",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    databaseName: "cpg_tmpl",
    roleName: "cpg_tmpl_role",
    repoSlug: "cedar",
    worktreeSlug: "main",
    pathHash: "abcd1234",
    root: "/tmp/wt",
    mode: "test" as const,
    port: 5433,
    dispose: async () => {},
  }));
  const markTemplate = vi.fn(async () => ({ databaseName: "cpg_tmpl" }));
  const migrate = vi.fn(async () => {});

  await withMockedLifecycle({ ensureIfNeeded, markTemplate }, async () => {
    const { setupTemplateMode } = await import("../src/adapters/template-mode.ts");
    const result = await setupTemplateMode({ migrate, setEnv: false });
    expect(result.status).toBe("ensured");
    expect(process.env.CEDAR_PG_ADMIN_URL).toBe(
      "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    );
    expect(migrate).toHaveBeenCalledWith({
      databaseUrl: "postgresql://role:pw@127.0.0.1:5433/cpg_tmpl",
      adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
      databaseName: "cpg_tmpl",
      roleName: "cpg_tmpl_role",
    });
    expect(markTemplate).toHaveBeenCalledWith({
      root: "/tmp/wt",
      mode: "test",
      databaseName: "cpg_tmpl",
      adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    });
  });
});

test("setupTemplateMode without migrate does not markTemplate", async () => {
  const ensureIfNeeded = vi.fn(async () => ({
    status: "ensured" as const,
    databaseUrl: "postgresql://role:pw@127.0.0.1:5433/cpg_tmpl",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    databaseName: "cpg_tmpl",
    roleName: "cpg_tmpl_role",
    repoSlug: "cedar",
    worktreeSlug: "main",
    pathHash: "abcd1234",
    root: "/tmp/wt",
    mode: "test" as const,
    port: 5433,
    dispose: async () => {},
  }));
  const markTemplate = vi.fn(async () => ({ databaseName: "cpg_tmpl" }));

  await withMockedLifecycle({ ensureIfNeeded, markTemplate }, async () => {
    const { setupTemplateMode } = await import("../src/adapters/template-mode.ts");
    await setupTemplateMode({ setEnv: false });
    expect(markTemplate).not.toHaveBeenCalled();
  });
});

test("setupTemplateMode skips mark when ensure is skipped", async () => {
  const ensureIfNeeded = vi.fn(async () => ({
    status: "skipped" as const,
    reason: "disabled" as const,
  }));
  const markTemplate = vi.fn(async () => ({ databaseName: "x" }));
  const migrate = vi.fn(async () => {});

  await withMockedLifecycle({ ensureIfNeeded, markTemplate }, async () => {
    const { setupTemplateMode } = await import("../src/adapters/template-mode.ts");
    const result = await setupTemplateMode({ migrate });
    expect(result).toEqual({ status: "skipped", reason: "disabled" });
    expect(migrate).not.toHaveBeenCalled();
    expect(markTemplate).not.toHaveBeenCalled();
  });
});

test("setupTemplateWorker clones with JEST_WORKER_ID and setEnv", async () => {
  const prevJest = process.env.JEST_WORKER_ID;
  const prevCedar = process.env.CEDAR_PG;
  const prevUrl = process.env.TEST_DATABASE_URL;
  process.env.JEST_WORKER_ID = "3";
  delete process.env.CEDAR_PG;
  delete process.env.TEST_DATABASE_URL;

  const cloneFromTemplate = vi.fn(async () => ({
    databaseUrl: "postgresql://role:pw@127.0.0.1:5433/cpg_tmpl_c_3",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    databaseName: "cpg_tmpl_c_3",
    roleName: "cpg_tmpl_role",
    templateName: "cpg_tmpl",
    port: 5433,
    dispose: async () => {},
  }));

  try {
    await withMockedLifecycle({ cloneFromTemplate }, async () => {
      const { setupTemplateWorker } = await import("../src/adapters/template-mode.ts");
      await setupTemplateWorker({ root: "/tmp/wt" });
      expect(cloneFromTemplate).toHaveBeenCalledWith({
        root: "/tmp/wt",
        mode: "test",
        name: "3",
        setEnv: true,
      });
    });
  } finally {
    if (prevJest === undefined) delete process.env.JEST_WORKER_ID;
    else process.env.JEST_WORKER_ID = prevJest;
    if (prevCedar === undefined) delete process.env.CEDAR_PG;
    else process.env.CEDAR_PG = prevCedar;
    if (prevUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = prevUrl;
  }
});

test("ensureWorkerDatabase is idempotent per process", async () => {
  const prevCedar = process.env.CEDAR_PG;
  const prevUrl = process.env.TEST_DATABASE_URL;
  delete process.env.CEDAR_PG;
  delete process.env.TEST_DATABASE_URL;

  const cloneFromTemplate = vi.fn(async () => ({
    databaseUrl: "postgresql://role:pw@127.0.0.1:5433/cpg_tmpl_c_1",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    databaseName: "cpg_tmpl_c_1",
    roleName: "cpg_tmpl_role",
    templateName: "cpg_tmpl",
    port: 5433,
    dispose: async () => {},
  }));

  try {
    await withMockedLifecycle({ cloneFromTemplate }, async () => {
      const { ensureWorkerDatabase } = await import("../src/adapters/template-mode.ts");
      await ensureWorkerDatabase({ name: "1" });
      await ensureWorkerDatabase({ name: "1" });
      expect(cloneFromTemplate).toHaveBeenCalledTimes(1);
    });
  } finally {
    if (prevCedar === undefined) delete process.env.CEDAR_PG;
    else process.env.CEDAR_PG = prevCedar;
    if (prevUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = prevUrl;
  }
});

test("teardownTemplateMode disposes test lease", async () => {
  const dispose = vi.fn(async () => ({ dropped: false as const, reason: "no-lease" as const }));
  await withMockedLifecycle({ dispose }, async () => {
    const { teardownTemplateMode } = await import("../src/adapters/template-mode.ts");
    await teardownTemplateMode({ root: "/tmp/wt" });
    expect(dispose).toHaveBeenCalledWith({ root: "/tmp/wt", mode: "test" });
  });
});

test("resolveMigrateFromEnv loads migrate export from file URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cedarpg-migrate-"));
  const file = join(dir, "migrate.mjs");
  writeFileSync(
    file,
    `export async function migrate(ctx) { globalThis.__cedarMigrateCtx = ctx; }\n`,
  );
  const prev = process.env.CEDAR_PG_MIGRATE;
  process.env.CEDAR_PG_MIGRATE = pathToFileURL(file).href;

  try {
    vi.resetModules();
    const { resolveMigrateFromEnv } = await import("../src/adapters/template-mode.ts");
    const migrate = await resolveMigrateFromEnv();
    expect(typeof migrate).toBe("function");
    await migrate?.({
      databaseUrl: "u",
      adminUrl: "a",
      databaseName: "d",
      roleName: "r",
    });
    expect((globalThis as { __cedarMigrateCtx?: unknown }).__cedarMigrateCtx).toEqual({
      databaseUrl: "u",
      adminUrl: "a",
      databaseName: "d",
      roleName: "r",
    });
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_MIGRATE;
    else process.env.CEDAR_PG_MIGRATE = prev;
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  }
});

test("createTemplateGlobalSetup wires migrate hook", async () => {
  const ensureIfNeeded = vi.fn(async () => ({
    status: "ensured" as const,
    databaseUrl: "postgresql://role:pw@127.0.0.1:5433/cpg_tmpl",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    databaseName: "cpg_tmpl",
    roleName: "cpg_tmpl_role",
    repoSlug: "cedar",
    worktreeSlug: "main",
    pathHash: "abcd1234",
    root: "/tmp/wt",
    mode: "test" as const,
    port: 5433,
    dispose: async () => {},
  }));
  const markTemplate = vi.fn(async () => ({ databaseName: "cpg_tmpl" }));
  const migrate = vi.fn(async () => {});

  await withMockedLifecycle({ ensureIfNeeded, markTemplate }, async () => {
    const { createTemplateGlobalSetup } = await import("../src/adapters/template-mode.ts");
    await createTemplateGlobalSetup({ migrate })();
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(markTemplate).toHaveBeenCalledTimes(1);
  });
});

test("jest template default export uses CEDAR_PG_MIGRATE", async () => {
  const ensureIfNeeded = vi.fn(async () => ({
    status: "ensured" as const,
    databaseUrl: "postgresql://role:pw@127.0.0.1:5433/cpg_tmpl",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    databaseName: "cpg_tmpl",
    roleName: "cpg_tmpl_role",
    repoSlug: "cedar",
    worktreeSlug: "main",
    pathHash: "abcd1234",
    root: "/tmp/wt",
    mode: "test" as const,
    port: 5433,
    dispose: async () => {},
  }));
  const markTemplate = vi.fn(async () => ({ databaseName: "cpg_tmpl" }));

  const dir = mkdtempSync(join(tmpdir(), "cedarpg-migrate-"));
  const file = join(dir, "migrate.mjs");
  writeFileSync(file, `export default async function migrate() {}\n`);
  const prev = process.env.CEDAR_PG_MIGRATE;
  process.env.CEDAR_PG_MIGRATE = pathToFileURL(file).href;

  try {
    await withMockedLifecycle({ ensureIfNeeded, markTemplate }, async () => {
      const mod = await import("../src/adapters/jest-template.ts");
      await mod.default();
      expect(markTemplate).toHaveBeenCalledTimes(1);
    });
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_MIGRATE;
    else process.env.CEDAR_PG_MIGRATE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
