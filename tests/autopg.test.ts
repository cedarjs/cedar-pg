import { expect, test } from "vite-plus/test";
import {
  adminUrlFor,
  buildDatabaseUrl,
  connectWhileStartingUp,
  parseHostStatus,
  rolePasswordFor,
  ROLE_PASSWORD_SCHEME,
} from "../src/providers/autopg.ts";

test("parseHostStatus requires numeric port", () => {
  expect(parseHostStatus('{"port":5433,"status":"online"}')).toEqual({ port: 5433 });
  expect(() => parseHostStatus('{"status":"online"}')).toThrow(/missing numeric port/);
  expect(() => parseHostStatus("not-json")).toThrow(/invalid JSON/);
});

test("parseHostStatus reports the registered port without judging liveness", () => {
  // Real `autopg status --json` for an installed-but-stopped pm2 host: the port
  // is registration, not a listener. TCP is the only liveness gate (host.ts).
  // Bare postmaster: status=stopped / pid=null while runtime.live=true — still
  // not an attach/reinstall signal.
  const stopped = `{
    "installed": true,
    "name": "autopg-server",
    "status": "stopped",
    "pid": null,
    "port": 25432,
    "dataDir": "/home/user/.autopg/data",
    "socketDir": "/run/user/1000/pgserve",
    "logsDir": "/home/user/.autopg/logs",
    "runtime": { "live": true, "port": 25432, "pid": 1686040 },
    "supervisor": "pm2"
  }`;
  expect(parseHostStatus(stopped)).toEqual({
    port: 25432,
    dataDir: "/home/user/.autopg/data",
    socketDir: "/run/user/1000/pgserve",
    logsDir: "/home/user/.autopg/logs",
  });
  // autopg reports `dataDir: null` when config.json is missing — absent, not guessed.
  expect(parseHostStatus('{"port":25432,"dataDir":null,"socketDir":""}')).toEqual({
    port: 25432,
  });
  // Supervisor-specific status strings (systemd-user / launchd tiers) never
  // hide the port from attach.
  expect(parseHostStatus('{"port":55432,"status":"running"}')).toEqual({ port: 55432 });
  expect(parseHostStatus('{"port":5432,"running":false}')).toEqual({ port: 5432 });
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

function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

test("connectWhileStartingUp retries 57P03 until the postmaster is query-ready", async () => {
  const startingUp = Object.assign(new Error("the database system is starting up"), {
    code: "57P03",
  });
  let attempts = 0;
  const client = await connectWhileStartingUp(
    async () => {
      attempts += 1;
      if (attempts < 3) throw startingUp;
      return "client";
    },
    { pollMs: 100, ...fakeClock() },
  );
  expect(client).toBe("client");
  expect(attempts).toBe(3);
});

test("connectWhileStartingUp throws other errors at once and 57P03 after the grace period", async () => {
  const refused = Object.assign(new Error("password authentication failed"), { code: "28P01" });
  let attempts = 0;
  await expect(
    connectWhileStartingUp(async () => {
      attempts += 1;
      throw refused;
    }, fakeClock()),
  ).rejects.toBe(refused);
  expect(attempts).toBe(1);

  const startingUp = Object.assign(new Error("the database system is starting up"), {
    code: "57P03",
  });
  attempts = 0;
  await expect(
    connectWhileStartingUp(
      async () => {
        attempts += 1;
        throw startingUp;
      },
      { readyMs: 1_000, pollMs: 250, ...fakeClock() },
    ),
  ).rejects.toBe(startingUp);
  expect(attempts).toBe(5);
});
