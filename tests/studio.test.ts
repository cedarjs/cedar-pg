import { expect, test } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStudio, openStudio, runStudio, studioChildRunning } from "../src/adapters/studio.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "cedarpg-studio-"));
}

function writePkg(dir: string, deps: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", version: "1.0.0", devDependencies: deps }),
  );
}

test("detectStudio returns null when no ORM packages", () => {
  const root = tempRoot();
  try {
    writePkg(root);
    expect(detectStudio({ root })).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectStudio finds prisma from package.json", () => {
  const root = tempRoot();
  try {
    writePkg(root, { prisma: "^6.0.0" });
    const studio = detectStudio({ root });
    expect(studio?.kind).toBe("prisma");
    expect(studio?.args).toContain("studio");
    expect(studio?.cwd).toBe(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectStudio finds drizzle-kit and prefers prisma when both", () => {
  const root = tempRoot();
  try {
    writePkg(root, { prisma: "^6.0.0", "drizzle-kit": "^0.30.0" });
    expect(detectStudio({ root })?.kind).toBe("prisma");
    expect(detectStudio({ root, prefer: "drizzle" })?.kind).toBe("drizzle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectStudio walks from an app package up to the worktree", () => {
  const root = tempRoot();
  try {
    writePkg(root, { prisma: "^6.0.0" });
    const app = join(root, "apps", "web");
    writePkg(app, { "drizzle-kit": "^0.30.0" });
    const nested = detectStudio({ root, cwd: app });
    expect(nested?.kind).toBe("drizzle");
    expect(nested?.cwd).toBe(app);
    expect(detectStudio({ root })?.kind).toBe("prisma");
    const forced = detectStudio({ root, cwd: app, prefer: "prisma" });
    expect(forced?.kind).toBe("prisma");
    expect(forced?.cwd).toBe(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectStudio does not walk outside the worktree", () => {
  const worktree = tempRoot();
  const other = tempRoot();
  try {
    writePkg(worktree, { prisma: "^6.0.0" });
    writePkg(other);
    expect(detectStudio({ root: worktree, cwd: other })).toBeNull();
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("detectStudio prefer falls back to npx at cwd when the package is missing", () => {
  const root = tempRoot();
  try {
    writePkg(root);
    const studio = detectStudio({ root, prefer: "prisma" });
    expect(studio?.kind).toBe("prisma");
    expect(studio?.command).toBe("npx");
    expect(studio?.shell).toBe(true);
    expect(studio?.cwd).toBe(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectStudio resolves local bin when installed", () => {
  const root = tempRoot();
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { prisma: "1.0.0" },
      }),
    );
    const pkgDir = join(root, "node_modules", "prisma");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "prisma", version: "1.0.0", bin: { prisma: "build/index.js" } }),
    );
    mkdirSync(join(pkgDir, "build"), { recursive: true });
    writeFileSync(join(pkgDir, "build", "index.js"), "#!/usr/bin/env node\n");
    const studio = detectStudio({ root });
    expect(studio?.kind).toBe("prisma");
    expect(studio?.shell).toBe(false);
    expect(studio?.command).toContain(join("node_modules", "prisma", "build", "index.js"));
    expect(studio?.cwd).toBe(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runStudio returns the child exit code", async () => {
  const root = tempRoot();
  try {
    const code = await runStudio({
      databaseUrl: "postgres://x",
      studio: {
        kind: "prisma",
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        cwd: root,
        shell: false,
      },
    });
    expect(code).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openStudio surfaces spawn errors instead of throwing uncaught", async () => {
  const root = tempRoot();
  try {
    const missing = join(root, "no-such-studio-bin");
    const err = await new Promise<Error>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("expected spawn error")), 3000);
      const child = openStudio({
        databaseUrl: "postgres://x",
        studio: {
          kind: "prisma",
          command: missing,
          args: ["studio"],
          cwd: root,
          shell: false,
        },
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        resolve(e);
      });
    });
    expect(err).toBeInstanceOf(Error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("studioChildRunning is true until the process exits", async () => {
  const root = tempRoot();
  try {
    const child = openStudio({
      databaseUrl: "postgres://x",
      studio: {
        kind: "prisma",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 30_000)"],
        cwd: root,
        shell: false,
      },
    });
    expect(studioChildRunning(child)).toBe(true);
    child.kill();
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    expect(studioChildRunning(child)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
