import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    maxWorkers:
      Number(process.env.VITEST_MAX_WORKERS) > 0 ? Number(process.env.VITEST_MAX_WORKERS) : 2,
    include: ["*.test.ts", "src/**/*.test.ts", "ui/**/*.test.ts", "scripts/**/*.test.mjs"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
