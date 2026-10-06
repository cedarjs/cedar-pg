import { expect, test } from "vite-plus/test";
import { cedarPgAttachCommand, cedarPgRunCommand } from "../src/adapters/nx.ts";

test("cedarPgRunCommand wraps the db:ready command with cedarpg run", () => {
  expect(cedarPgRunCommand("dev", "prisma migrate deploy")).toBe(
    "cedarpg run --mode=dev -- prisma migrate deploy",
  );
  expect(cedarPgRunCommand("test", "vitest run", "./bin/cedarpg")).toBe(
    "./bin/cedarpg run --mode=test -- vitest run",
  );
});

test("cedarPgAttachCommand wraps a child with attach-only cedarpg run", () => {
  expect(cedarPgAttachCommand("dev", "node dist/server.js")).toBe(
    "cedarpg run --attach --mode=dev -- node dist/server.js",
  );
  expect(cedarPgAttachCommand("test", "playwright test", "./bin/cedarpg")).toBe(
    "./bin/cedarpg run --attach --mode=test -- playwright test",
  );
});
