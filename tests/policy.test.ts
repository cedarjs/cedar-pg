import { expect, test } from "vite-plus/test";
import {
  isCedarPgManagedUrl,
  isExternalDatabaseEscapeHatch,
  resolveEnsureSkip,
} from "../src/core/policy.ts";

function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    prev[key] = process.env[key];
    const value = patch[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(patch)) {
      const value = prev[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("isCedarPgManagedUrl detects cpg database and role", () => {
  expect(
    isCedarPgManagedUrl(
      "postgresql://cpg_cedar_main_test_abcd1234_role:secret@127.0.0.1:25432/cpg_cedar_main_test_abcd1234",
    ),
  ).toBe(true);
  expect(isCedarPgManagedUrl("postgresql://postgres:postgres@127.0.0.1:5432/app")).toBe(false);
  expect(isCedarPgManagedUrl("file:./.cedar/test.db")).toBe(false);
  expect(isCedarPgManagedUrl(undefined)).toBe(false);
});

test("isExternalDatabaseEscapeHatch ignores file and cedarpg urls", () => {
  expect(isExternalDatabaseEscapeHatch("postgresql://neon.tech/db")).toBe(true);
  expect(isExternalDatabaseEscapeHatch("file:./test.db")).toBe(false);
  expect(
    isExternalDatabaseEscapeHatch(
      "postgresql://cpg_x_test_abcd1234_role:x@127.0.0.1:25432/cpg_x_test_abcd1234",
    ),
  ).toBe(false);
});

test("resolveEnsureSkip honors CEDAR_PG disable from env", () => {
  withEnv({ CEDAR_PG: "0", TEST_DATABASE_URL: undefined }, () => {
    expect(resolveEnsureSkip()).toEqual({ skip: true, reason: "disabled" });
  });
});

test("resolveEnsureSkip accepts explicit disabled: false for opt-in hosts", () => {
  withEnv({ CEDAR_PG: "0", TEST_DATABASE_URL: undefined }, () => {
    expect(resolveEnsureSkip({ disabled: false })).toEqual({ skip: false });
  });
});

test("resolveEnsureSkip honors real external url input", () => {
  withEnv(
    {
      CEDAR_PG: undefined,
      TEST_DATABASE_URL: undefined,
      CEDAR_PG_FORCE: undefined,
    },
    () => {
      expect(resolveEnsureSkip({ url: "postgresql://external/db" })).toEqual({
        skip: true,
        reason: "external-url",
        databaseUrl: "postgresql://external/db",
      });
    },
  );
});

test("resolveEnsureSkip does not treat stale cedarpg URL as escape hatch", () => {
  expect(
    resolveEnsureSkip({
      disabled: false,
      url: "postgresql://cpg_cedar_main_test_abcd1234_role:old@127.0.0.1:25432/cpg_cedar_main_test_abcd1234",
    }),
  ).toEqual({ skip: false });
});

test("resolveEnsureSkip ignores sqlite file urls", () => {
  expect(resolveEnsureSkip({ disabled: false, url: "file:./.cedar/test.db" })).toEqual({
    skip: false,
  });
});

test("resolveEnsureSkip force overrides escape hatch", () => {
  expect(
    resolveEnsureSkip({
      disabled: false,
      force: true,
      url: "postgresql://external/db",
    }),
  ).toEqual({ skip: false });
});
