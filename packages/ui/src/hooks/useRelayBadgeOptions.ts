import { useEffect, useMemo, useState } from "react";

import type { ISub2ApiService, Sub2ApiSitesState } from "@zcode/services";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

/**
 * 中转站（Sub2API）密钥供应商 → 模型选择器品牌灰标映射。
 * MikikoCC 站点显示「Mikiko」，用户自建 sub2api 站点显示「Sub2api」。
 */
export function useRelayBadgeOptions(): Readonly<Record<string, string>> {
  const baseServices = useBaseWorkspaceServices();
  const sub2ApiService = baseServices?.sub2ApiService as ISub2ApiService | undefined;
  const [sites, setSites] = useState<Sub2ApiSitesState | null>(null);

  useEffect(() => {
    if (!sub2ApiService) {
      return;
    }
    let disposed = false;
    void sub2ApiService.getSites().then((state) => {
      if (!disposed) {
        setSites(state);
      }
    });
    const disposable = sub2ApiService.onDidChange((state) => setSites(state));
    return () => {
      disposed = true;
      disposable.dispose();
    };
  }, [sub2ApiService]);

  return useMemo(() => {
    const map: Record<string, string> = {};
    for (const site of sites?.sites ?? []) {
      const badge = site.siteName || (site.kind === "mikikocc" ? "MikikoCC" : "Sub2api");
      for (const binding of site.providerBindings ?? []) {
        map[binding.providerId] = badge;
      }
    }
    return map;
  }, [sites]);
}
