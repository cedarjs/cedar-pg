import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    entry: {
      index: "src/index.ts",
      cli: "src/cli.ts",
      "vite-plus": "src/adapters/vite-plus.ts",
      nx: "src/adapters/nx.ts",
      vitest: "src/adapters/vitest.ts",
      jest: "src/adapters/jest.ts",
    },
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
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
