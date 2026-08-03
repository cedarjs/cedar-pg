import { teardown } from "./jest.ts";

/**
 * Jest `globalTeardown` entry (default export).
 *
 * ```js
 * globalTeardown: require.resolve('@cedarjs/pg/jest-teardown')
 * ```
 */
export default teardown;
