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

test("loadTestEnv injects keys from .cedarpg/test.env without overriding", () => {
  const root = mkdtempSync(join(tmpdir(), "cedar-pg-env-"));
  dirs.push(root);
  const dir = join(root, STATE_DIRNAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "test.env"),
    "DATABASE_URL=postgresql://u:p@127.0.0.1:1/cpg_x\nTEST_DATABASE_URL=postgresql://u:p@127.0.0.1:1/cpg_x\n",
    { mode: 0o600 },
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
