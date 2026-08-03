import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { CLI_NAME, PASSWORD_SALT_PREFIX, STATE_DIRNAME } from "../src/core/constants.ts";

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
  name: string;
  bin?: Record<string, string>;
};

test("CLI_NAME matches package.json bin", () => {
  const bins = Object.keys(pkg.bin ?? {});
  expect(bins).toEqual([CLI_NAME]);
});

test("state dir is product-owned .cedarpg (not .pg or under .autopg)", () => {
  expect(STATE_DIRNAME).toBe(".cedarpg");
  expect(STATE_DIRNAME).not.toBe(".pg");
  expect(STATE_DIRNAME).not.toContain("autopg");
});

test("password salt is opaque and frozen for scheme v2", () => {
  expect(PASSWORD_SALT_PREFIX).toBe("cedar-pg");
});
