import { expect, test } from "vite-plus/test";
import { ephemeralHostRecipe, resolveEphemeralHostPolicy } from "../src/providers/host.ts";

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
