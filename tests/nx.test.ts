import { expect, test } from "vite-plus/test";
import {
  cedarPgNxTargets,
  cedarPgRunCommand,
  CEDAR_PG_NX_ACQUIRE_DEV,
  CEDAR_PG_NX_ACQUIRE_TEST,
  envFilePath,
  nxTargetHints,
  relativeEnvFile,
} from "../src/adapters/nx.ts";
import { STATE_DIRNAME } from "../src/core/constants.ts";

test("cedarPgNxTargets exposes acquire/dispose commands", () => {
  const targets = cedarPgNxTargets();
  expect(targets[CEDAR_PG_NX_ACQUIRE_DEV]?.command).toContain("acquire --mode=dev");
  expect(targets[CEDAR_PG_NX_ACQUIRE_TEST]?.command).toContain("acquire --mode=test");
  expect(targets[CEDAR_PG_NX_ACQUIRE_DEV]?.cache).toBe(false);
});

test("nxTargetHints stays compatible with cedarPgNxTargets commands", () => {
  const hints = nxTargetHints("./bin/cedarpg");
  expect(hints["db:acquire"]?.command).toBe("./bin/cedarpg acquire --mode=dev");
});

test("cedarPgRunCommand wraps child with cedarpg run", () => {
  expect(cedarPgRunCommand("dev", "yarn tsx scripts/dev.ts")).toBe(
    "cedarpg run --mode=dev -- yarn tsx scripts/dev.ts",
  );
  expect(cedarPgRunCommand("test", "vitest run", "cedarpg")).toBe(
    "cedarpg run --mode=test -- vitest run",
  );
});

test("relativeEnvFile and envFilePath point at .cedarpg/<mode>.env", () => {
  expect(relativeEnvFile("dev")).toBe(`${STATE_DIRNAME}/dev.env`);
  expect(envFilePath("/tmp/worktree", "test")).toBe(`/tmp/worktree/${STATE_DIRNAME}/test.env`);
});
