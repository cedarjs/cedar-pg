import { teardownTemplateMode } from "./template-mode.ts";

/** Jest globalTeardown: `require.resolve("@cedarjs/pg/jest/template/teardown")`. */
export default async function globalTeardown(): Promise<void> {
  await teardownTemplateMode();
}
