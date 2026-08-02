import { expect, test } from "vite-plus/test";
import {
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

test("rolePasswordFor is stable for password scheme v1", () => {
  expect(ROLE_PASSWORD_SCHEME).toBe("v1");
  const db = "cpg_cedar_main_dev_abcd1234";
  const a = rolePasswordFor(db);
  const b = rolePasswordFor(db);
  expect(a).toBe(b);
  expect(a).toMatch(/^[a-f0-9]{32}$/);
  expect(rolePasswordFor("other")).not.toBe(a);
  // Golden digest — salt prefix is frozen; bump ROLE_PASSWORD_SCHEME if it changes.
  expect(a).toBe("9c7ae5fd9d2dcd1c041d6aa8a6ad9fc4");
});

test("buildDatabaseUrl is TCP with encoded role password", () => {
  const db = "cpg_cedar_main_dev_abcd1234";
  const role = `${db}_role`;
  const url = buildDatabaseUrl({ port: 5433, databaseName: db, roleName: role });
  const password = rolePasswordFor(db);
  expect(url).toBe(
    `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:5433/${db}`,
  );
  expect(url).not.toContain("host=");
  expect(url).toContain("127.0.0.1");
});
