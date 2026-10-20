export type E2EStoreBridgeImportMetaEnv = {
  VITE_MIKIKO_E2E_STORE_BRIDGE?: string;
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
};

function readE2EStoreBridgeImportMetaEnv(): E2EStoreBridgeImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: E2EStoreBridgeImportMetaEnv }).env ??
    {}) as E2EStoreBridgeImportMetaEnv;
}

export function shouldExposeE2EStoreBridge(
  env: E2EStoreBridgeImportMetaEnv = readE2EStoreBridgeImportMetaEnv(),
): boolean {
  // WDIO/Vite 新标记优先；旧键仅兼容纯测试夹具，显式关闭的新键不能被旧值重新开启。
  const enabled = env.VITE_MIKIKO_E2E_STORE_BRIDGE ?? env.VITE_ZCODE_E2E_STORE_BRIDGE;
  return typeof window !== "undefined" && enabled === "1";
}
