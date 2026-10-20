/** Source Server Host 现有实现的受控边界，不创建第二份目录或连接状态。 */
export const hostSourceServerModule = {
  id: "host-source-server",
  owner: "remote-workspace",
  requires: ["desktop", "rpc", "server", "services", "shared"],
  provides: ["host-source-server"],
  publicEntrypoints: [
    "contract.ts",
    "../sourceServerConnectionManager.ts",
    "../sourceServerDirectory.ts",
  ],
} as const;
