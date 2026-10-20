export const sourceServerDaemonBoundaryModule = {
  id: "source-server-daemon-boundary",
  requires: ["services", "zcode-server-cli"],
  provides: ["source-server-daemon-handoff", "source-server-stdio-proxy"],
  publicEntrypoints: ["contract.ts", "../runtime/updateHandoff.ts", "../server-core/proxyStdio.ts"],
} as const;
