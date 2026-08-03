import { expect, test } from "vite-plus/test";
import {
  buildDatabaseUrl,
  installArgsFor,
  parseHostStatus,
  postmasterArgsFor,
  rolePasswordFor,
  ROLE_PASSWORD_SCHEME,
  usesOwnedPostmaster,
} from "../src/providers/autopg.ts";

test("parseHostStatus requires numeric port", () => {
  expect(parseHostStatus('{"port":5433,"running":true}')).toEqual({ port: 5433 });
  expect(() => parseHostStatus('{"running":true}')).toThrow(/missing numeric port/);
  expect(() => parseHostStatus('{"port":5432,"running":false}')).toThrow(/not running/);
  expect(() => parseHostStatus("not-json")).toThrow(/invalid JSON/);
});

test("installArgsFor defaults to bare install (pm2 path)", () => {
  expect(installArgsFor({})).toEqual(["install"]);
  expect(installArgsFor({ noUi: true, port: 5433, dataDir: "/tmp/pg" })).toEqual([
    "install",
    "--no-ui",
    "--port",
    "5433",
    "--data",
    "/tmp/pg",
  ]);
});

test("installArgsFor / postmasterArgsFor match CI ephemeral recipe", () => {
  const opts = {
    ram: true,
    noPm2: true,
    noUi: true,
    port: 55432,
    dataDir: "/dev/shm/autopg-ci",
  };
  expect(usesOwnedPostmaster(opts)).toBe(true);
  expect(usesOwnedPostmaster({ ram: true })).toBe(true);
  expect(usesOwnedPostmaster({ noPm2: true })).toBe(true);
  expect(usesOwnedPostmaster({ noUi: true })).toBe(false);

  expect(installArgsFor(opts)).toEqual([
    "install",
    "--no-pm2",
    "--no-ui",
    "--port",
    "55432",
    "--data",
    "/dev/shm/autopg-ci",
  ]);
  // ram implies --no-pm2 on install even when noPm2 is omitted
  expect(installArgsFor({ ram: true, dataDir: "/dev/shm/x" })).toEqual([
    "install",
    "--no-pm2",
    "--data",
    "/dev/shm/x",
  ]);
  expect(postmasterArgsFor(opts)).toEqual([
    "postmaster",
    "--ram",
    "--port",
    "55432",
    "--socket-dir",
    "/dev/shm/autopg-ci",
  ]);
  // non-ram owned postmaster also passes --data
  expect(postmasterArgsFor({ noPm2: true, dataDir: "/tmp/pg", port: 5433 })).toEqual([
    "postmaster",
    "--port",
    "5433",
    "--socket-dir",
    "/tmp/pg",
    "--data",
    "/tmp/pg",
  ]);
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
