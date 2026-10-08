import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";

// Single autopg pin (scripts/autopg-version), inlined so runtime can warn on an older host.
const define = {
  __CEDAR_PG_AUTOPG_PIN__: JSON.stringify(readFileSync("scripts/autopg-version", "utf8").trim()),
};

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    entry: {
      index: "src/index.ts",
      cli: "src/cli.ts",
      "vite-plus": "src/adapters/vite-plus.ts",
      vitest: "src/adapters/vitest.ts",
      "vitest-template": "src/adapters/vitest-template.ts",
      jest: "src/adapters/jest.ts",
      "jest-teardown": "src/adapters/jest-teardown.ts",
      "test-env": "src/adapters/test-env.ts",
      "dev-env": "src/adapters/dev-env.ts",
      "jest-template": "src/adapters/jest-template.ts",
    },

    define,
    dts: true,
    format: ["esm", "cjs"],
    sourcemap: true,
    // Keep package.json exports under plan paths (./vite-plus, not ./adapters/…)
    exports: false,
  },
  run: {
    tasks: {
      // package.json has `build`; task names must not duplicate — smoke depends on it.
      smoke: {
        command: "node scripts/smoke.mjs",
        dependsOn: ["build"],
        cache: false,
      },
      "smoke:pg": {
        command: "node scripts/smoke-pg.mjs",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  define,
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
