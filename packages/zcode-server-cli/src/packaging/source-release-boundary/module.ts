export const sourceServerPackagingModule = {
  id: "source-server-packaging",
  requires: ["shared", "zcode-server-cli"],
  provides: ["source-server-release-packaging"],
  publicEntrypoints: ["contract.ts", "../remoteAssetRelease.ts", "../stageArchives.ts"],
} as const;
