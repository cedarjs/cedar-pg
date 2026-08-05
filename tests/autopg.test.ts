import { expect, test } from "vite-plus/test";
import {
  adminUrlFor,
  buildDatabaseUrl,
  parseHostStatus,
  rolePasswordFor,
  ROLE_PASSWORD_SCHEME,
} from "../src/providers/autopg.ts";

test("parseHostStatus requires numeric port", () => {
  expect(parseHostStatus('{"port":5433,"running":true}')).toEqual({ port: 5433 });
  expect(() => parseHostStatus('{"running":true}')).toThrow(/missing numeric port/);
  expect(() => parseHostStatus('{"port":5432,"running":false}')).toThrow(/not running/);
  expect(() => parseHostStatus("not-json")).toThrow(/invalid JSON/);
});

test("adminUrlFor uses autopg default credentials and AUTOPG_PG_* overrides", () => {
  expect(adminUrlFor(25432, {})).toBe("postgresql://postgres:postgres@127.0.0.1:25432/postgres");
  expect(
    adminUrlFor(55432, {
      AUTOPG_PG_USER: "admin",
      AUTOPG_PG_PASSWORD: "s3cret/x",
    }),
  ).toBe("postgresql://admin:s3cret%2Fx@127.0.0.1:55432/postgres");
  expect(adminUrlFor(1, { PGSERVE_PG_PASSWORD: "legacy" })).toBe(
    "postgresql://postgres:legacy@127.0.0.1:1/postgres",
  );
});

test("rolePasswordFor is stable for password scheme v2", () => {
  expect(ROLE_PASSWORD_SCHEME).toBe("v2");
  const role = "cpg_cedar_main_dev_abcd1234_role";
  const a = rolePasswordFor(role);
  const b = rolePasswordFor(role);
  expect(a).toBe(b);
  expect(a).toMatch(/^[a-f0-9]{32}$/);
  expect(rolePasswordFor("other")).not.toBe(a);
  // Golden digest — salt prefix + roleName input are frozen; bump ROLE_PASSWORD_SCHEME if either changes.
  expect(a).toBe("2df8248143eff6d10327225968beb4d8");
});

test("buildDatabaseUrl derives password from roleName (TEMPLATE-clone safe)", () => {
  const templateDb = "cpg_cedar_main_test_abcd1234";
  const cloneDb = "cpg_cedar_main_test_worker1";
  const role = `${templateDb}_role`;
  const password = rolePasswordFor(role);

  const templateUrl = buildDatabaseUrl({
    port: 5433,
    databaseName: templateDb,
    roleName: role,
  });
  const cloneUrl = buildDatabaseUrl({
    port: 5433,
    databaseName: cloneDb,
    roleName: role,
  });

  expect(templateUrl).toBe(
    `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:5433/${templateDb}`,
  );
  expect(cloneUrl).toBe(
    `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:5433/${cloneDb}`,
  );
  // Same role → same password even when databaseName differs (CREATE DATABASE … TEMPLATE).
  expect(new URL(templateUrl).password).toBe(new URL(cloneUrl).password);
  expect(cloneUrl).not.toContain("host=");
  expect(cloneUrl).toContain("127.0.0.1");
});
