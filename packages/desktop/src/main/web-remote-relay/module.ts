// 依赖与 architecture-policy.yaml 同步；新增文件必须属于此 managed 边界。
export const desktopWebRemoteRelayModule = {
  id: "desktop-web-remote-relay",
  requires: ["client", "desktop", "shared", "web-remote-relay", "services"],
  provides: ["desktop-web-remote-relay"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "../webRemoteControlTransport.ts",
    "../webRemoteControlRelayAuthProvider.ts",
    "../webRemoteControlRelayAuthStorageProvider.ts",
  ],
} as const;
