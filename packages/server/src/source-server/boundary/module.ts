/** remote-workspace 的 Source Server 传输边界；IO 继续归已有 adapter。 */
export const sourceServerTransportModule = {
  id: "source-server-transport",
  requires: ["server", "shared"],
  provides: ["source-server-transport"],
  publicEntrypoints: ["contract.ts", "../transportAdapter.ts", "../sourceServerProbe.ts"],
} as const;
