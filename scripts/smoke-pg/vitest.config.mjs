import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["@cedarjs/pg/vitest"],
    include: ["vitest.test.mjs"],
    // Single fork keeps this smoke deterministic and cheap on Actions.
    pool: "forks",
    fileParallelism: false,
  },
});
