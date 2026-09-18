import { expect, test } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminUrlFor } from "../src/providers/autopg.ts";
import {
  discoveryFromRecipe,
  ensureHostRunning,
  ephemeralHostRecipe,
  EPHEMERAL_SHM_HINT,
  formatHostStartError,
  looksLikeShmSpaceError,
  pruneStaleEphemeralDataDirs,
  resolveHostStartPolicy,
  waitForListener,
} from "../src/providers/host.ts";

test("resolveHostStartPolicy from CEDAR_PG_EPHEMERAL_HOST and CI", () => {
  expect(resolveHostStartPolicy({ CEDAR_PG_EPHEMERAL_HOST: "1" })).toBe("ephemeral");
  expect(resolveHostStartPolicy({ CEDAR_PG_EPHEMERAL_HOST: "0", CI: "true" })).toBe("local");
  expect(resolveHostStartPolicy({ CI: "true" })).toBe("ephemeral");
  expect(resolveHostStartPolicy({ CI: "1" })).toBe("local");
  expect(resolveHostStartPolicy({})).toBe("local");
});

test("ephemeralHostRecipe uses RAM on Linux when /dev/shm is available", () => {
  expect(ephemeralHostRecipe({ platform: "linux", shmAvailable: true, uid: 1000 })).toEqual({
    dataDir: "/dev/shm/cedar-pg-1000",
    port: 55432,
    postmasterArgs: [
      "postmaster",
      "--ram",
      "--port",
      "55432",
      "--socket-dir",
      "/dev/shm/cedar-pg-1000",
      "--data",
      "/dev/shm/cedar-pg-1000",
    ],
  });
});

test("ephemeralHostRecipe falls back to disk tmpdir without --ram", () => {
  expect(
    ephemeralHostRecipe({
      platform: "darwin",
      shmAvailable: false,
      tmpDir: "/tmp/cedar-test",
      uid: 1,
      port: 55433,
    }),
  ).toEqual({
    dataDir: "/tmp/cedar-test/cedar-pg-host",
    port: 55433,
    postmasterArgs: [
      "postmaster",
      "--port",
      "55433",
      "--socket-dir",
      "/tmp/cedar-test/cedar-pg-host",
      "--data",
      "/tmp/cedar-test/cedar-pg-host",
    ],
  });
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

test("waitForListener probes once by default and polls until TCP accepts", async () => {
  let attempts = 0;
  expect(
    await waitForListener({
      port: 1,
      now: () => 0,
      canConnect: async () => {
        attempts += 1;
        return false;
      },
    }),
  ).toBe(false);
  expect(attempts).toBe(1);

  expect(
    await waitForListener({
      port: 1,
      readyMs: 1000,
      pollMs: 1,
      now: () => 0,
      sleep: async () => {},
      canConnect: async () => {
        attempts += 1;
        return attempts >= 3;
      },
    }),
  ).toBe(true);
  expect(attempts).toBe(3);
});

test("waitForListener throws what failure() reports (spawn error / early exit)", async () => {
  await expect(
    waitForListener({
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

test("waitForListener returns false when the grace period expires", async () => {
  let t = 0;
  expect(
    await waitForListener({
      port: 9,
      readyMs: 5,
      pollMs: 1,
      now: () => t,
      sleep: async () => {
        t += 2;
      },
      canConnect: async () => false,
    }),
  ).toBe(false);
});

test("looksLikeShmSpaceError matches quota / ENOSPC / 53100", () => {
  expect(looksLikeShmSpaceError("ERROR: Disk quota exceeded")).toBe(true);
  expect(looksLikeShmSpaceError("No space left on device")).toBe(true);
  expect(looksLikeShmSpaceError("could not write ... ENOSPC")).toBe(true);
  expect(looksLikeShmSpaceError("SQLSTATE 53100")).toBe(true);
  expect(looksLikeShmSpaceError("permission denied")).toBe(false);
});

test("formatHostStartError appends shm hint only for RAM quota failures", () => {
  const msg = formatHostStartError("Disk quota exceeded during initdb", true);
  expect(msg).toContain("Disk quota exceeded");
  expect(msg).toContain(EPHEMERAL_SHM_HINT);
  expect(formatHostStartError("permission denied", true)).not.toContain("Enlarge tmpfs");
  expect(formatHostStartError("Disk quota exceeded")).not.toContain("Enlarge tmpfs");
});

test("pruneStaleEphemeralDataDirs removes cedar-pg / pgserve / PostgreSQL leftovers only", () => {
  const root = mkdtempSync(join(tmpdir(), "cedar-shm-"));
  const dataDir = join(root, "cedar-pg-host");
  const keep = join(root, "other-file");
  mkdirSync(dataDir);
  mkdirSync(join(root, "cedar-pg-9"));
  mkdirSync(join(root, "pgserve-abc"));
  mkdirSync(join(root, "PostgreSQL.12345"));
  writeFileSync(keep, "x");

  const removed = pruneStaleEphemeralDataDirs({ dataDir, shmRoot: root });

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

/**
 * Fake `autopg` that reports an installed-but-stopped pm2 registration
 * (`status=stopped`, `pid=null`, `runtime.live=true`) on `port`.
 *
 * Start verbs are configurable: pm2-less `restart` may no-op (exit 0) or fail;
 * registered revive uses `postmaster` on the status JSON data/socket dirs.
 */
function writeFakeAutopg(opts: {
  port: number;
  restart?: "fail" | "noop";
  postmaster?: "fail" | "listen";
}): { bin: string; log: string; dir: string; dataDir: string; socketDir: string; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "cedar-fake-autopg-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "autopg");
  const dataDir = join(dir, "data");
  const socketDir = join(dir, "sock");
  const pidFile = join(dir, "postmaster.pid");
  mkdirSync(dataDir);
  mkdirSync(socketDir);

  const statusJson = JSON.stringify({
    installed: true,
    name: "autopg-server",
    status: "stopped",
    pid: null,
    port: opts.port,
    dataDir,
    socketDir,
    supervisor: "pm2",
    runtime: { live: true, port: opts.port, pid: null },
  });

  const listenJs = [
    `const { createServer } = require("node:net");`,
    `const { writeFileSync } = require("node:fs");`,
    `const server = createServer();`,
    `server.listen(${opts.port}, "127.0.0.1", () => {`,
    `  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `});`,
  ].join("");

  const restart = opts.restart ?? "fail";
  const postmaster = opts.postmaster ?? "fail";

  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `echo "$@" >> ${JSON.stringify(log)}`,
      'if [ "$1" = "status" ]; then',
      `  echo ${JSON.stringify(statusJson)}`,
      "  exit 0",
      "fi",
      'if [ "$1" = "restart" ]; then',
      ...(restart === "noop"
        ? ['  echo "autopg: respawned daemon" >&2', "  exit 0"]
        : ['  echo "fake autopg: restart refused" >&2', "  exit 1"]),
      "fi",
      'if [ "$1" = "install" ]; then',
      '  echo "pm2 is required for this command" >&2',
      "  exit 1",
      "fi",
      'if [ "$1" = "postmaster" ]; then',
      ...(postmaster === "listen"
        ? [`  exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(listenJs)}`]
        : ['  echo "fake autopg: postmaster refused" >&2', "  exit 1"]),
      "fi",
      'echo "fake autopg: $1 refused" >&2',
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { bin, log, dir, dataDir, socketDir, pidFile };
}

function killPidFile(pidFile: string): void {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isFinite(pid) && pid > 0) process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

/** `CEDAR_PG_EPHEMERAL_HOST=0` pins local policy regardless of ambient `CI`. */
async function withLocalPolicy(fn: () => Promise<void>): Promise<void> {
  const previous = process.env.CEDAR_PG_EPHEMERAL_HOST;
  process.env.CEDAR_PG_EPHEMERAL_HOST = "0";
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.CEDAR_PG_EPHEMERAL_HOST;
    else process.env.CEDAR_PG_EPHEMERAL_HOST = previous;
  }
}

function calls(log: string): string[] {
  return readFileSync(log, "utf8").trim().split("\n");
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test("ensureHostRunning attaches on TCP even when status JSON says stopped", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake = writeFakeAutopg({ port });

  try {
    await withLocalPolicy(async () => {
      expect(await ensureHostRunning(fake.bin)).toEqual({
        port,
        adminUrl: adminUrlFor(port),
        bin: fake.bin,
      });
    });
    expect(calls(fake.log)).toEqual(["status --json"]);
  } finally {
    server.close();
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("ensureHostRunning revives a dead registered host via postmaster, not pm2 install", async () => {
  const port = await freePort();
  const fake = writeFakeAutopg({ port, restart: "fail", postmaster: "listen" });

  try {
    await withLocalPolicy(async () => {
      expect(await ensureHostRunning(fake.bin)).toEqual({
        port,
        adminUrl: adminUrlFor(port),
        bin: fake.bin,
      });
    });
    expect(calls(fake.log)).toEqual([
      "status --json",
      "restart",
      `postmaster --port ${port} --data ${fake.dataDir} --socket-dir ${fake.socketDir}`,
    ]);
  } finally {
    killPidFile(fake.pidFile);
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("ensureHostRunning fail-closed on a dead registered port does not require pm2", async () => {
  const port = await freePort();
  const fake = writeFakeAutopg({ port, restart: "fail", postmaster: "fail" });
  const postmasterArgv = `postmaster --port ${port} --data ${fake.dataDir} --socket-dir ${fake.socketDir}`;

  try {
    await withLocalPolicy(async () => {
      await expect(ensureHostRunning(fake.bin)).rejects.toThrow(
        new RegExp(
          `registered on 127\\.0\\.0\\.1:${port} but nothing is listening[\\s\\S]*` +
            "autopg restart: exit 1[\\s\\S]*autopg postmaster --port",
        ),
      );
    });
    const invoked = calls(fake.log);
    expect(invoked[0]).toBe("status --json");
    expect(invoked).toContain("restart");
    expect(invoked).toContain(postmasterArgv);
    expect(invoked).not.toContain("install");
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("ensureHostRunning treats pm2-less restart (respawned daemon, no TCP) as a no-op", async () => {
  const port = await freePort();
  const fake = writeFakeAutopg({ port, restart: "noop", postmaster: "listen" });

  try {
    await withLocalPolicy(async () => {
      expect(await ensureHostRunning(fake.bin)).toEqual({
        port,
        adminUrl: adminUrlFor(port),
        bin: fake.bin,
      });
    });
    expect(calls(fake.log)).toEqual([
      "status --json",
      "restart",
      "status --json",
      `postmaster --port ${port} --data ${fake.dataDir} --socket-dir ${fake.socketDir}`,
    ]);
  } finally {
    killPidFile(fake.pidFile);
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
