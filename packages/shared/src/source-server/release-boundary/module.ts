/** distribution 的纯元数据合同；不持有下载或发布状态。 */
export const sourceServerReleaseContractModule = {
  id: "source-server-release-contract",
  requires: [],
  provides: ["source-server-release-contract"],
  publicEntrypoints: ["contract.ts", "../release.ts"],
} as const;
