import { expect, test } from "vite-plus/test";
import { buildDatabaseName, buildRoleName, buildCloneDatabaseName } from "../src/core/naming.ts";
import type { WorktreeIdentity } from "../src/core/worktree.ts";

function id(
  partial: Partial<WorktreeIdentity> &
    Pick<WorktreeIdentity, "repoSlug" | "worktreeSlug" | "pathHash">,
): WorktreeIdentity {
  return {
    root: "/tmp/example",
    ...partial,
  };
}

test("buildDatabaseName is observable and includes mode + hash", () => {
  const name = buildDatabaseName(
    id({
      repoSlug: "cedar",
      worktreeSlug: "feat_auth",
      pathHash: "a1b2c3d4",
    }),
    "dev",
  );
  expect(name).toBe("cpg_cedar_feat_auth_dev_a1b2c3d4");
  expect(name.length).toBeLessThanOrEqual(63);
});

test("buildDatabaseName truncates long slugs but keeps mode and hash", () => {
  const name = buildDatabaseName(
    id({
      repoSlug: "a".repeat(40),
      worktreeSlug: "b".repeat(40),
      pathHash: "deadbeef",
    }),
    "test",
  );
  expect(name.length).toBeLessThanOrEqual(63);
  expect(name.startsWith("cpg_")).toBe(true);
  expect(name.endsWith("_test_deadbeef")).toBe(true);
});

test("buildRoleName stays within 63 chars", () => {
  const db = "cpg_cedar_feat_auth_dev_a1b2c3d4";
  const role = buildRoleName(db);
  expect(role).toBe(`${db}_role`);
  expect(role.length).toBeLessThanOrEqual(63);
});

test("buildCloneDatabaseName keeps suffix and stays ≤63", () => {
  const template = "cpg_cedar_main_test_abcd1234";
  expect(buildCloneDatabaseName(template, "1")).toBe(`${template}_c_1`);
  expect(buildCloneDatabaseName(template, "Worker-2!")).toBe(`${template}_c_worker_2`);

  const long = "c".repeat(60);
  const clone = buildCloneDatabaseName(long, "worker99");
  expect(clone.length).toBeLessThanOrEqual(63);
  expect(clone.endsWith("_c_worker99")).toBe(true);
});

const longIds = ["abcd1234", "abc99999"].map((pathHash) =>
  buildDatabaseName(
    id({
      repoSlug: "cedar_pg",
      worktreeSlug: "claude_fix_autopg_v3_2_2_postinstall",
      pathHash,
    }),
    "test",
  ),
);

test("buildRoleName keeps the full mode + hash for long worktree names", () => {
  expect(longIds).toEqual([
    "cpg_cedar_pg_claude_fix_autopg_v3_2_2_postinstall_test_abcd1234",
    "cpg_cedar_pg_claude_fix_autopg_v3_2_2_postinstall_test_abc99999",
  ]);
  const roles = longIds.map(buildRoleName);
  expect(roles[0]).not.toBe(roles[1]);
  expect(roles[0]).toBe("cpg_cedar_pg_claude_fix_autopg_v3_2_2_postin_test_abcd1234_role");
  for (const role of roles) {
    expect(role.length).toBeLessThanOrEqual(63);
  }
  expect(roles[1].endsWith("_test_abc99999_role")).toBe(true);
});

test("buildCloneDatabaseName keeps mode + hash with the default pid/time suffix", () => {
  const suffix = `${123456}_${Date.UTC(2026, 9, 8).toString(36)}`;
  for (const template of longIds) {
    const clone = buildCloneDatabaseName(template, suffix);
    expect(clone.length).toBeLessThanOrEqual(63);
    expect(clone.startsWith("cpg_cedar_")).toBe(true);
    expect(clone.endsWith(`${template.slice(-14)}_c_${suffix}`)).toBe(true);
  }
});
