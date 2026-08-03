import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
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

function writeLiveTestArtifacts(root: string, envBody: string): void {
  const dir = join(root, STATE_DIRNAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "test.json"),
    JSON.stringify({
      schemaVersion: 1,
      mode: "test",
      root,
      repoSlug: "cedar",
      worktreeSlug: "main",
      pathHash: "abcd1234",
      databaseName: "cpg_cedar_main_test_abcd1234",
      roleName: "cpg_cedar_main_test_abcd1234_role",
      port: 5432,
      pid: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(dir, "test.env"), envBody, { mode: 0o600 });
}

test("loadTestEnv injects keys from .cedarpg/test.env without overriding", () => {
  const root = mkdtempSync(join(tmpdir(), "cedar-pg-env-"));
  dirs.push(root);
  writeLiveTestArtifacts(
    root,
    "DATABASE_URL=postgresql://u:p@127.0.0.1:1/cpg_x\nTEST_DATABASE_URL=postgresql://u:p@127.0.0.1:1/cpg_x\n",
  );

  process.env.DATABASE_URL = "keep-me";
  loadTestEnv(root);

  expect(process.env.DATABASE_URL).toBe("keep-me");
  expect(process.env.TEST_DATABASE_URL).toBe("postgresql://u:p@127.0.0.1:1/cpg_x");
});

test("loadTestEnv no-ops when file is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "cedar-pg-env-missing-"));
  dirs.push(root);
  loadTestEnv(root);
  expect(process.env.DATABASE_URL).toBeUndefined();
});

test("loadTestEnv ignores stale test.env without a matching lease", () => {
  const root = mkdtempSync(join(tmpdir(), "cedar-pg-env-stale-"));
  dirs.push(root);
  const dir = join(root, STATE_DIRNAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "test.env"),
    "DATABASE_URL=postgresql://stale\nTEST_DATABASE_URL=postgresql://stale\n",
    { mode: 0o600 },
  );

  loadTestEnv(root);

  expect(process.env.DATABASE_URL).toBeUndefined();
  expect(process.env.TEST_DATABASE_URL).toBeUndefined();
});
