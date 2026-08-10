import { expect, test } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminUrlFor } from "../src/providers/autopg.ts";
import {
  discoveryFromRecipe,
  ephemeralHostRecipe,
  EPHEMERAL_SHM_HINT,
  formatHostStartError,
  looksLikeShmSpaceError,
  pruneStaleEphemeralDataDirs,
  resolveEphemeralHostPolicy,
  waitForOwnedPostmaster,
} from "../src/providers/host.ts";

test("resolveEphemeralHostPolicy from CEDAR_PG_EPHEMERAL_HOST and CI", () => {
  expect(resolveEphemeralHostPolicy({ CEDAR_PG_EPHEMERAL_HOST: "1" })).toBe("ephemeral");
  expect(resolveEphemeralHostPolicy({ CEDAR_PG_EPHEMERAL_HOST: "0", CI: "true" })).toBe("local");
  expect(resolveEphemeralHostPolicy({ CI: "true" })).toBe("ephemeral");
  expect(resolveEphemeralHostPolicy({ CI: "1" })).toBe("local");
  expect(resolveEphemeralHostPolicy({})).toBe("local");
});

test("ephemeralHostRecipe uses RAM on Linux when /dev/shm is available", () => {
  const recipe = ephemeralHostRecipe({
    platform: "linux",
    shmAvailable: true,
    uid: 1000,
  });
  expect(recipe.dataDir).toBe("/dev/shm/cedar-pg-1000");
  expect(recipe.port).toBe(55432);
  expect(recipe.installArgs).toEqual([
    "install",
    "--no-pm2",
    "--no-ui",
    "--port",
    "55432",
    "--data",
    "/dev/shm/cedar-pg-1000",
  ]);
  expect(recipe.postmasterArgs).toEqual([
    "postmaster",
    "--ram",
    "--port",
    "55432",
    "--socket-dir",
    "/dev/shm/cedar-pg-1000",
    "--data",
    "/dev/shm/cedar-pg-1000",
  ]);
});

test("ephemeralHostRecipe falls back to disk tmpdir without --ram", () => {
  const recipe = ephemeralHostRecipe({
    platform: "darwin",
    shmAvailable: false,
    tmpDir: "/tmp/cedar-test",
    uid: 1,
    port: 55433,
  });
  expect(recipe.dataDir).toBe("/tmp/cedar-test/cedar-pg-host");
  expect(recipe.port).toBe(55433);
  expect(recipe.installArgs).toEqual([
    "install",
    "--no-pm2",
    "--no-ui",
    "--port",
    "55433",
    "--data",
    "/tmp/cedar-test/cedar-pg-host",
  ]);
  expect(recipe.postmasterArgs).toEqual([
    "postmaster",
    "--port",
    "55433",
    "--socket-dir",
    "/tmp/cedar-test/cedar-pg-host",
    "--data",
    "/tmp/cedar-test/cedar-pg-host",
  ]);
});

test("discoveryFromRecipe uses recipe port + adminUrlFor (no status)", () => {
  const recipe = ephemeralHostRecipe({
    platform: "linux",
    shmAvailable: true,
    uid: 7,
    port: 55432,
  });
  expect(discoveryFromRecipe("/bin/autopg", recipe)).toEqual({
    port: 55432,
    adminUrl: adminUrlFor(55432),
    bin: "/bin/autopg",
  });
});

test("waitForOwnedPostmaster resolves when TCP accepts", async () => {
  let attempts = 0;
  await waitForOwnedPostmaster({
    port: 1,
    readyMs: 1000,
    pollMs: 1,
    now: () => 0,
    sleep: async () => {},
    canConnect: async () => {
      attempts += 1;
      return attempts >= 2;
    },
  });
  expect(attempts).toBe(2);
});

test("waitForOwnedPostmaster throws when failure() reports spawn/exit", async () => {
  await expect(
    waitForOwnedPostmaster({
      port: 1,
      readyMs: 1000,
      pollMs: 1,
      now: () => 0,
      sleep: async () => {},
      canConnect: async () => false,
      failure: () => new Error("spawn blew up"),
    }),
  ).rejects.toThrow(/spawn blew up/);
});

test("waitForOwnedPostmaster times out when TCP never accepts", async () => {
  let t = 0;
  await expect(
    waitForOwnedPostmaster({
      port: 9,
      readyMs: 5,
      pollMs: 1,
      now: () => t,
      sleep: async () => {
        t += 2;
      },
      canConnect: async () => false,
    }),
  ).rejects.toThrow(/Timed out waiting for autopg host after 5ms/);
});

test("looksLikeShmSpaceError matches quota / ENOSPC / 53100", () => {
  expect(looksLikeShmSpaceError("ERROR: Disk quota exceeded")).toBe(true);
  expect(looksLikeShmSpaceError("No space left on device")).toBe(true);
  expect(looksLikeShmSpaceError("could not write ... ENOSPC")).toBe(true);
  expect(looksLikeShmSpaceError("SQLSTATE 53100")).toBe(true);
  expect(looksLikeShmSpaceError("permission denied")).toBe(false);
});

test("formatHostStartError appends shm hint for RAM quota failures", () => {
  const msg = formatHostStartError("Disk quota exceeded during initdb", true);
  expect(msg).toContain("Disk quota exceeded");
  expect(msg).toContain(EPHEMERAL_SHM_HINT);
  expect(formatHostStartError("permission denied", true)).not.toContain("Enlarge tmpfs");
  expect(formatHostStartError("Disk quota exceeded", false)).not.toContain("Enlarge tmpfs");
});

test("pruneStaleEphemeralDataDirs removes leftovers when port is dead", () => {
  const root = mkdtempSync(join(tmpdir(), "cedar-shm-"));
  const dataDir = join(root, "cedar-pg-host");
  const keep = join(root, "other-file");
  mkdirSync(dataDir);
  mkdirSync(join(root, "cedar-pg-9"));
  mkdirSync(join(root, "pgserve-abc"));
  mkdirSync(join(root, "PostgreSQL.12345"));
  writeFileSync(keep, "x");

  const removed = pruneStaleEphemeralDataDirs({
    dataDir,
    shmRoot: root,
    portLive: false,
  });

  expect(removed.sort()).toEqual(
    [
      dataDir,
      join(root, "cedar-pg-9"),
      join(root, "pgserve-abc"),
      join(root, "PostgreSQL.12345"),
    ].sort(),
  );
  expect(existsSync(keep)).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("pruneStaleEphemeralDataDirs is a no-op when port is live", () => {
  const root = mkdtempSync(join(tmpdir(), "cedar-shm-"));
  const dataDir = join(root, "cedar-pg-host");
  mkdirSync(dataDir);
  expect(
    pruneStaleEphemeralDataDirs({
      dataDir,
      shmRoot: root,
      portLive: true,
    }),
  ).toEqual([]);
  expect(existsSync(dataDir)).toBe(true);
  rmSync(root, { recursive: true, force: true });
});
