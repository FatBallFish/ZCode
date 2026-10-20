export const webSelfHostedRelayModule = {
  id: "web-self-hosted-relay",
  requires: ["client", "shared", "ui", "web"],
  provides: ["web-self-hosted-relay"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "../webRemoteControlTransport.ts",
    "../webRemoteControlRelayAuthProvider.ts",
  ],
} as const;
