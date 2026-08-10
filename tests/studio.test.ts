import { expect, test } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStudio } from "../src/adapters/studio.ts";

test("detectStudio returns null when no ORM packages", () => {
  const root = mkdtempSync(join(tmpdir(), "cedarpg-studio-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
    expect(detectStudio({ root })).toBeNull();
    expect(detectStudio({ root, prefer: false })).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectStudio finds prisma from package.json", () => {
  const root = mkdtempSync(join(tmpdir(), "cedarpg-studio-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        devDependencies: { prisma: "^6.0.0" },
      }),
    );
    const studio = detectStudio({ root });
    expect(studio?.kind).toBe("prisma");
    expect(studio?.args).toContain("studio");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectStudio finds drizzle-kit and prefers prisma when both", () => {
  const root = mkdtempSync(join(tmpdir(), "cedarpg-studio-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        devDependencies: { prisma: "^6.0.0", "drizzle-kit": "^0.30.0" },
      }),
    );
    expect(detectStudio({ root })?.kind).toBe("prisma");
    expect(detectStudio({ root, prefer: "drizzle" })?.kind).toBe("drizzle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectStudio resolves local bin when installed", () => {
  const root = mkdtempSync(join(tmpdir(), "cedarpg-studio-"));
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
    expect(studio?.bin).toContain(join("node_modules", "prisma", "build", "index.js"));
    expect(studio?.command).toBe(studio?.bin);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
