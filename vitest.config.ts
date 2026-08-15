import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The Playwright fixture module imports @playwright/test, which registers a
    // global test runner. It is exercised by its own contract test, not by
    // importing the fixture into vitest.
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 20_000,
  },
});
