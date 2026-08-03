import { expect, test, vi } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EnsureIfNeededResult } from "../src/core/lifecycle.ts";

function ensuredLease(
  overrides: Partial<Extract<EnsureIfNeededResult, { status: "ensured" }>> = {},
): Extract<EnsureIfNeededResult, { status: "ensured" }> {
  return {
    status: "ensured",
    databaseUrl: "postgresql://role:pw@127.0.0.1:5433/cpg_tmpl",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    databaseName: "cpg_tmpl",
    roleName: "cpg_tmpl_role",
    repoSlug: "cedar",
    worktreeSlug: "main",
    pathHash: "abcd1234",
    root: "/tmp/wt",
    mode: "test",
    port: 5433,
    dispose: async () => {},
    ...overrides,
  };
}

async function withMockedLifecycle<T>(
  mocks: {
    ensureIfNeeded?: ReturnType<typeof vi.fn>;
    markTemplate?: ReturnType<typeof vi.fn>;
    cloneFromTemplateIfNeeded?: ReturnType<typeof vi.fn>;
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
      cloneFromTemplateIfNeeded:
        mocks.cloneFromTemplateIfNeeded ?? actual.cloneFromTemplateIfNeeded,
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
  const ensureIfNeeded = vi.fn(async () => ensuredLease());
  const markTemplate = vi.fn(async () => ({
    databaseName: "cpg_tmpl",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
  }));
  const migrate = vi.fn(async () => {});

  await withMockedLifecycle({ ensureIfNeeded, markTemplate }, async () => {
    const { setupTemplateMode } = await import("../src/adapters/template-mode.ts");
    const result = await setupTemplateMode({ migrate, setEnv: false });
    expect(result.status).toBe("ensured");
    expect(process.env.CEDAR_PG_ADMIN_URL).toBeUndefined();
    expect(migrate).toHaveBeenCalledWith({
      databaseUrl: "postgresql://role:pw@127.0.0.1:5433/cpg_tmpl",
      adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
      databaseName: "cpg_tmpl",
      roleName: "cpg_tmpl_role",
    });
    expect(markTemplate).toHaveBeenCalledWith({
      root: "/tmp/wt",
      mode: "test",
      adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    });
  });
});

test("setupTemplateMode skips migrate/mark when ensure is skipped", async () => {
  const ensureIfNeeded = vi.fn(async () => ({
    status: "skipped" as const,
    reason: "disabled" as const,
  }));
  const markTemplate = vi.fn(async () => ({
    databaseName: "x",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
  }));
  const migrate = vi.fn(async () => {});

  await withMockedLifecycle({ ensureIfNeeded, markTemplate }, async () => {
    const { setupTemplateMode } = await import("../src/adapters/template-mode.ts");
    const result = await setupTemplateMode({ migrate });
    expect(result).toEqual({ status: "skipped", reason: "disabled" });
    expect(migrate).not.toHaveBeenCalled();
    expect(markTemplate).not.toHaveBeenCalled();
  });
});

test("ensureWorkerDatabase clones via cloneFromTemplateIfNeeded", async () => {
  const prevJest = process.env.JEST_WORKER_ID;
  const prevCedar = process.env.CEDAR_PG;
  const prevUrl = process.env.TEST_DATABASE_URL;
  process.env.JEST_WORKER_ID = "3";
  delete process.env.CEDAR_PG;
  delete process.env.TEST_DATABASE_URL;

  const cloneFromTemplateIfNeeded = vi.fn(async () => ({
    status: "cloned" as const,
    databaseUrl: "postgresql://role:pw@127.0.0.1:5433/cpg_tmpl_c_3",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    databaseName: "cpg_tmpl_c_3",
    roleName: "cpg_tmpl_role",
    templateName: "cpg_tmpl",
    port: 5433,
    dispose: async () => {},
  }));

  try {
    await withMockedLifecycle({ cloneFromTemplateIfNeeded }, async () => {
      const { ensureWorkerDatabase } = await import("../src/adapters/template-mode.ts");
      await ensureWorkerDatabase({ root: "/tmp/wt" });
      expect(cloneFromTemplateIfNeeded).toHaveBeenCalledWith({
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
  const prevJest = process.env.JEST_WORKER_ID;
  delete process.env.CEDAR_PG;
  delete process.env.TEST_DATABASE_URL;
  process.env.JEST_WORKER_ID = "1";

  const cloneFromTemplateIfNeeded = vi.fn(async () => ({
    status: "cloned" as const,
    databaseUrl: "postgresql://role:pw@127.0.0.1:5433/cpg_tmpl_c_1",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
    databaseName: "cpg_tmpl_c_1",
    roleName: "cpg_tmpl_role",
    templateName: "cpg_tmpl",
    port: 5433,
    dispose: async () => {},
  }));

  try {
    await withMockedLifecycle({ cloneFromTemplateIfNeeded }, async () => {
      const { ensureWorkerDatabase } = await import("../src/adapters/template-mode.ts");
      await ensureWorkerDatabase();
      await ensureWorkerDatabase();
      expect(cloneFromTemplateIfNeeded).toHaveBeenCalledTimes(1);
    });
  } finally {
    if (prevCedar === undefined) delete process.env.CEDAR_PG;
    else process.env.CEDAR_PG = prevCedar;
    if (prevUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = prevUrl;
    if (prevJest === undefined) delete process.env.JEST_WORKER_ID;
    else process.env.JEST_WORKER_ID = prevJest;
  }
});

test("vitest template teardown disposes lease root", async () => {
  const ensureIfNeeded = vi.fn(async () => ensuredLease());
  const markTemplate = vi.fn(async () => ({
    databaseName: "cpg_tmpl",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
  }));
  const dispose = vi.fn(async () => ({ dropped: false as const, reason: "no-lease" as const }));
  const migrate = vi.fn(async () => {});

  await withMockedLifecycle({ ensureIfNeeded, markTemplate, dispose }, async () => {
    const { createGlobalSetup } = await import("../src/adapters/vitest-template.ts");
    const teardown = await createGlobalSetup({ migrate })();
    await teardown();
    expect(dispose).toHaveBeenCalledWith({ root: "/tmp/wt", mode: "test" });
  });
});

test("jest createGlobalSetup wires migrate hook", async () => {
  const ensureIfNeeded = vi.fn(async () => ensuredLease());
  const markTemplate = vi.fn(async () => ({
    databaseName: "cpg_tmpl",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
  }));
  const migrate = vi.fn(async () => {});

  await withMockedLifecycle({ ensureIfNeeded, markTemplate }, async () => {
    const { createGlobalSetup } = await import("../src/adapters/jest-template.ts");
    await createGlobalSetup({ migrate })();
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(markTemplate).toHaveBeenCalledTimes(1);
  });
});

test("jest template default requires CEDAR_PG_MIGRATE", async () => {
  const prev = process.env.CEDAR_PG_MIGRATE;
  delete process.env.CEDAR_PG_MIGRATE;
  try {
    vi.resetModules();
    const mod = await import("../src/adapters/jest-template.ts");
    await expect(mod.default()).rejects.toThrow(/CEDAR_PG_MIGRATE|createGlobalSetup/);
  } finally {
    if (prev === undefined) delete process.env.CEDAR_PG_MIGRATE;
    else process.env.CEDAR_PG_MIGRATE = prev;
    vi.resetModules();
  }
});

test("jest template default export uses CEDAR_PG_MIGRATE", async () => {
  const ensureIfNeeded = vi.fn(async () => ensuredLease());
  const markTemplate = vi.fn(async () => ({
    databaseName: "cpg_tmpl",
    adminUrl: "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
  }));

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
