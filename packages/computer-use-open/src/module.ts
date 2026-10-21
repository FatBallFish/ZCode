/**
 * computer-use-open 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const computerUseOpenModule = {
  id: "computer-use-open",
  requires: ["shared"],
  provides: ["computer-use-open"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
