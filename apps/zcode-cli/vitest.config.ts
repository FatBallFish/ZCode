import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 全量 Turbo 还会并发多个包；限制每包 worker，避免 CPU 排队击穿既有测试时限。
    maxWorkers:
      Number(process.env.VITEST_MAX_WORKERS) > 0 ? Number(process.env.VITEST_MAX_WORKERS) : 4,
    // Bugfix: 外部 zcode-cli 历史里同时存在 test/ 和 tests/ 目录；合入 apps 后需要同时保留两种约定，避免新增包测试被根 include 规则过滤掉。
    include: [
      "test/**/*.test.ts",
      "tests/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
    ],
  },
});
