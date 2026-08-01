import { expect, test } from "vite-plus/test";
import { buildDatabaseName, buildRoleName } from "../src/core/naming.ts";
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
