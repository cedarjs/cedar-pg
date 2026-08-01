import { expect, test } from "vite-plus/test";
import { ensureIfNeeded } from "../src/core/lifecycle.ts";

function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    prev[key] = process.env[key];
    const value = patch[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const key of Object.keys(patch)) {
      const value = prev[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("ensureIfNeeded skips disabled without touching host", async () => {
  await withEnv({ CEDAR_PG: "0", TEST_DATABASE_URL: undefined }, async () => {
    const result = await ensureIfNeeded({ mode: "test" });
    expect(result).toEqual({ status: "skipped", reason: "disabled" });
  });
});

test("ensureIfNeeded skips external url and sets DATABASE_URL", async () => {
  const external = "postgresql://neon.example/db";
  await withEnv(
    {
      CEDAR_PG: undefined,
      TEST_DATABASE_URL: undefined,
      DATABASE_URL: undefined,
      CEDAR_PG_FORCE: undefined,
    },
    async () => {
      const result = await ensureIfNeeded({
        mode: "test",
        disabled: false,
        url: external,
        setEnv: true,
      });
      expect(result).toEqual({
        status: "skipped",
        reason: "external-url",
        databaseUrl: external,
      });
      expect(process.env.DATABASE_URL).toBe(external);
    },
  );
});

test("ensureIfNeeded does not skip stale cedar-pg urls", async () => {
  const stale =
    "postgresql://cpg_cedar_main_test_abcd1234_role:DEAD@127.0.0.1:25432/cpg_cedar_main_test_abcd1234";
  const skip = await ensureIfNeeded({
    mode: "test",
    disabled: true,
    url: stale,
  });
  // disabled short-circuits before host — proves policy composition path
  expect(skip).toEqual({ status: "skipped", reason: "disabled" });

  const policyOnly = await import("../src/core/policy.ts");
  expect(policyOnly.resolveEnsureSkip({ disabled: false, url: stale })).toEqual({
    skip: false,
  });
});
