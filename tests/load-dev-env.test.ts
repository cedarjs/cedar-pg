import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { loadDevEnv } from "../src/adapters/load-dev-env.ts";
import { loadTestEnv } from "../src/adapters/load-test-env.ts";
import { STATE_DIRNAME } from "../src/core/constants.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.DATABASE_URL;
  delete process.env.TEST_DATABASE_URL;
});

function writeLiveArtifacts(root: string, mode: "dev" | "test", envBody: string): void {
  const dir = join(root, STATE_DIRNAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, `${mode}.json`),
    JSON.stringify({
      schemaVersion: 1,
      mode,
      root,
      repoSlug: "cedar",
      worktreeSlug: "main",
      pathHash: "abcd1234",
      databaseName: `cpg_cedar_main_${mode}_abcd1234`,
      roleName: `cpg_cedar_main_${mode}_abcd1234_role`,
      port: 5432,
      pid: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(dir, `${mode}.env`), envBody, { mode: 0o600 });
}

test("loadDevEnv injects DATABASE_URL without overriding by default", () => {
  const root = mkdtempSync(join(tmpdir(), "cedar-pg-dev-env-"));
  dirs.push(root);
  writeLiveArtifacts(root, "dev", "DATABASE_URL=postgresql://u:p@127.0.0.1:1/cpg_dev\n");

  process.env.DATABASE_URL = "keep-me";
  loadDevEnv(root);

  expect(process.env.DATABASE_URL).toBe("keep-me");
});

test("loadDevEnv({ overwrite: true }) overrides existing DATABASE_URL", () => {
  const root = mkdtempSync(join(tmpdir(), "cedar-pg-dev-overwrite-"));
  dirs.push(root);
  writeLiveArtifacts(root, "dev", "DATABASE_URL=postgresql://u:p@127.0.0.1:1/cpg_dev\n");

  process.env.DATABASE_URL = "from-dotenv";
  loadDevEnv({ root, overwrite: true });

  expect(process.env.DATABASE_URL).toBe("postgresql://u:p@127.0.0.1:1/cpg_dev");
});

test("loadTestEnv({ overwrite: true }) overrides existing TEST_DATABASE_URL", () => {
  const root = mkdtempSync(join(tmpdir(), "cedar-pg-test-overwrite-"));
  dirs.push(root);
  writeLiveArtifacts(
    root,
    "test",
    "DATABASE_URL=postgresql://u:p@127.0.0.1:1/cpg_x\nTEST_DATABASE_URL=postgresql://u:p@127.0.0.1:1/cpg_x\n",
  );

  process.env.DATABASE_URL = "keep";
  process.env.TEST_DATABASE_URL = "from-dotenv";
  loadTestEnv({ root, overwrite: true });

  expect(process.env.DATABASE_URL).toBe("postgresql://u:p@127.0.0.1:1/cpg_x");
  expect(process.env.TEST_DATABASE_URL).toBe("postgresql://u:p@127.0.0.1:1/cpg_x");
});

test("loadDevEnv no-ops without a matching lease", () => {
  const root = mkdtempSync(join(tmpdir(), "cedar-pg-dev-stale-"));
  dirs.push(root);
  const dir = join(root, STATE_DIRNAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "dev.env"), "DATABASE_URL=postgresql://stale\n", { mode: 0o600 });

  loadDevEnv({ root, overwrite: true });
  expect(process.env.DATABASE_URL).toBeUndefined();
});
