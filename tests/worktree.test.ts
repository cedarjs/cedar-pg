import { expect, test } from "vite-plus/test";
import { resolveWorktreeIdentity } from "../src/core/worktree.ts";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

test("resolveWorktreeIdentity returns slugs and pathHash", () => {
  const identity = resolveWorktreeIdentity(here);
  expect(identity.root.length).toBeGreaterThan(0);
  expect(identity.repoSlug.length).toBeGreaterThan(0);
  expect(identity.worktreeSlug.length).toBeGreaterThan(0);
  expect(identity.pathHash).toMatch(/^[a-f0-9]{8}$/);
});

test("same root yields stable pathHash", () => {
  const a = resolveWorktreeIdentity(here);
  const b = resolveWorktreeIdentity(here);
  expect(a.pathHash).toBe(b.pathHash);
  expect(a.repoSlug).toBe(b.repoSlug);
});
