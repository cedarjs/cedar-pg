import { expect, test } from "vite-plus/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Fake `autopg` (v3.2 `status --json` shape) that reports an installed-but-stopped
 * pm2 registration (`status=stopped`, `ready=false`, `runtime.live=true`) on `port`.
 *
 * Start verbs are configurable: `restart` either refuses (pm2 unavailable, exit 1)
 * or, like v3.2, exits 0 only once its supervised postmaster listens (`ready`);
 * registered revive uses `postmaster` on the status JSON data/socket dirs.
 * `postmaster: "lose"` models a concurrent start winning the data-dir lock: a
 * background listener owns `<dataDir>/postmaster.pid` and ours exits 1.
 */
function writeFakeAutopg(opts: {
  port: number;
  restart?: "fail" | "ready";
  postmaster?: "fail" | "listen" | "lose";
  report?: { dataDir?: boolean; socketDir?: boolean };
}): {
  bin: string;
  log: string;
  dir: string;
  dataDir: string;
  socketDir: string;
  logsDir: string;
  pidFile: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "cedar-fake-autopg-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "autopg");
  const dataDir = join(dir, "data");
  const socketDir = join(dir, "sock");
  const logsDir = join(dir, "logs");
  const pidFile = join(dir, "postmaster.pid");
  mkdirSync(dataDir);
  mkdirSync(socketDir);

  const statusJson = JSON.stringify({
    installed: true,
    name: "autopg-server",
    status: "stopped",
    ready: false,
    supervisorStatus: "stopped",
    persisted: true,
    pid: null,
    port: opts.port,
    dataDir: opts.report?.dataDir === false ? null : dataDir,
    ...(opts.report?.socketDir === false ? {} : { socketDir }),
    logsDir,
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

  const probeJs = [
    `require("node:net").connect(${opts.port}, "127.0.0.1")`,
    `.on("connect", () => process.exit(0)).on("error", () => process.exit(1));`,
  ].join("");

  // Winner of a concurrent start, in its own process group (like a real
  // postmaster): owns the data dir now, listens shortly after.
  const winnerJs = [
    `const { createServer } = require("node:net");`,
    `setTimeout(() => createServer().listen(${opts.port}, "127.0.0.1"), 300);`,
  ].join("");
  const spawnWinnerJs = [
    `const { spawn } = require("node:child_process");`,
    `const { writeFileSync } = require("node:fs");`,
    `const w = spawn(process.execPath, ["-e", ${JSON.stringify(winnerJs)}], { detached: true, stdio: "ignore" });`,
    `writeFileSync(${JSON.stringify(join(dataDir, "postmaster.pid"))}, String(w.pid));`,
    `w.unref();`,
  ].join("");

  const restart = opts.restart ?? "fail";
  const postmaster = opts.postmaster ?? "fail";

  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "autopg 3.2.2"; exit 0; fi',
      `echo "$@" >> ${JSON.stringify(log)}`,
      'if [ "$1" = "status" ]; then',
      `  echo ${JSON.stringify(statusJson)}`,
      "  exit 0",
      "fi",
      'if [ "$1" = "restart" ]; then',
      ...(restart === "ready"
        ? [
            `  ${JSON.stringify(process.execPath)} -e ${JSON.stringify(listenJs)} >/dev/null 2>&1 &`,
            "  tries=0",
            `  until ${JSON.stringify(process.execPath)} -e ${JSON.stringify(probeJs)}; do`,
            "    tries=$((tries + 1))",
            '    if [ "$tries" -ge 200 ]; then echo "fake autopg: listener never became ready" >&2; exit 1; fi',
            "    sleep 0.05",
            "  done",
            '  echo "autopg: restarted and ready (pm2 process \\"autopg-server\\")"',
            "  exit 0",
          ]
        : [
            '  echo "autopg: pm2 is unavailable; cannot restart the configured AutoPG service" >&2',
            "  exit 1",
          ]),
      "fi",
      'if [ "$1" = "install" ]; then',
      '  echo "pm2 is required for this command" >&2',
      "  exit 1",
      "fi",
      'if [ "$1" = "postmaster" ]; then',
      ...(postmaster === "listen"
        ? [
            '  echo "fake autopg: postmaster starting"',
            `  exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(listenJs)}`,
          ]
        : postmaster === "lose"
          ? [
              `  ${JSON.stringify(process.execPath)} -e ${JSON.stringify(spawnWinnerJs)}`,
              '  echo "FATAL: lock file postmaster.pid already exists" >&2',
              "  exit 1",
            ]
          : ['  echo "fake autopg: postmaster refused" >&2', "  exit 1"]),
      "fi",
      'echo "fake autopg: $1 refused" >&2',
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { bin, log, dir, dataDir, socketDir, logsDir, pidFile };
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
    // Unsupervised revive keeps its output next to autopg's own logs.
    expect(readFileSync(join(fake.logsDir, "cedarpg-postmaster.log"), "utf8")).toContain(
      "postmaster starting",
    );
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
            "autopg restart: exit 1[\\s\\S]*autopg postmaster --port[\\s\\S]*" +
            "Postmaster log: .*cedarpg-postmaster\\.log",
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

test("ensureHostRunning attaches after a ready pm2 restart without reviving", async () => {
  const port = await freePort();
  const fake = writeFakeAutopg({ port, restart: "ready" });

  try {
    await withLocalPolicy(async () => {
      expect(await ensureHostRunning(fake.bin)).toEqual({
        port,
        adminUrl: adminUrlFor(port),
        bin: fake.bin,
      });
    });
    expect(calls(fake.log)).toEqual(["status --json", "restart", "status --json"]);
  } finally {
    killPidFile(fake.pidFile);
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("ensureHostRunning omits --socket-dir when autopg does not report one", async () => {
  const port = await freePort();
  const fake = writeFakeAutopg({
    port,
    postmaster: "listen",
    report: { socketDir: false },
  });

  try {
    await withLocalPolicy(async () => {
      expect((await ensureHostRunning(fake.bin)).port).toBe(port);
    });
    expect(calls(fake.log)).toContain(`postmaster --port ${port} --data ${fake.dataDir}`);
  } finally {
    killPidFile(fake.pidFile);
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("ensureHostRunning never guesses a data dir autopg does not report", async () => {
  const port = await freePort();
  const fake = writeFakeAutopg({ port, postmaster: "listen", report: { dataDir: false } });

  try {
    await withLocalPolicy(async () => {
      await expect(ensureHostRunning(fake.bin)).rejects.toThrow(
        /autopg postmaster: not attempted \(autopg status --json reports no dataDir\)/,
      );
    });
    expect(calls(fake.log).some((c) => c.startsWith("postmaster"))).toBe(false);
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("ensureHostRunning waits for a live data-dir owner instead of spawning a competitor", async () => {
  const port = await freePort();
  const fake = writeFakeAutopg({ port, postmaster: "listen" });
  // pm2 (or another acquire) is mid-start: postmaster.pid is live, TCP not yet.
  writeFileSync(join(fake.dataDir, "postmaster.pid"), `${process.pid}\n${fake.dataDir}\n`);
  const server = createServer();
  const late = setTimeout(() => server.listen(port, "127.0.0.1"), 300);

  try {
    await withLocalPolicy(async () => {
      expect((await ensureHostRunning(fake.bin)).port).toBe(port);
    });
    expect(calls(fake.log)).toEqual(["status --json", "restart"]);
  } finally {
    clearTimeout(late);
    server.close();
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("ensureHostRunning attaches to the winner after losing the data-dir lock", async () => {
  const port = await freePort();
  const fake = writeFakeAutopg({ port, postmaster: "lose" });
  const ownerPidFile = join(fake.dataDir, "postmaster.pid");

  try {
    await withLocalPolicy(async () => {
      expect((await ensureHostRunning(fake.bin)).port).toBe(port);
    });
    expect(calls(fake.log)).toContain(
      `postmaster --port ${port} --data ${fake.dataDir} --socket-dir ${fake.socketDir}`,
    );
  } finally {
    killPidFile(ownerPidFile);
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
