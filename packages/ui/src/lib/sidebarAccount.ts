/**
 * 左下角 footer 的账户展示源（单一事实，多处消费）。
 *
 * 展示规则与 WorkspaceSidebarFooter 历史行为一致：
 * - 用户在菜单里选中过某个中转站站点 → 展示该站点（邮箱 + 余额）；
 * - 未选中且无智谱 OAuth 用户 → 回退展示首个已登录中转站站点；
 * - 未选中且有智谱 OAuth 用户 → 展示智谱账号（relaySite 为 null）。
 *
 * 选中态放在窗口级 store：工作区与设置页各有一个 footer 实例，本地 state 会在
 * 实例切换时丢失（进设置页后回落智谱账号的根因）。此 hook 同时供
 * 「设置页跟随当前账户」意图写入使用（SessionPane / footer 齿轮）。
 */
import { useEffect, useState } from "react";

import type { UserInfo } from "@zcode/shared";
import { ISub2ApiService, type Sub2ApiSiteState } from "@zcode/services";

import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

export interface SidebarAccountDisplay {
  user: UserInfo | null;
  /** 已登录且启用的中转站站点（菜单可切换列表）。 */
  authedRelaySites: Sub2ApiSiteState[];
  /** 当前实际展示的中转站站点；展示智谱账号时为 null。 */
  relaySite: Sub2ApiSiteState | null;
  setRelaySiteSelection: (siteId: string | null) => void;
}

export function useSidebarAccountDisplay(): SidebarAccountDisplay {
  const user = useZCodeStore((state) => state.user);
  const selectedSiteId = useZCodeStore((state) => state.sidebarRelayAccountSiteId);
  const setRelaySiteSelection = useZCodeStore((state) => state.setSidebarRelayAccountSiteId);
  const baseServices = useBaseWorkspaceServices();
  const sub2ApiService = baseServices?.sub2ApiService as ISub2ApiService | undefined;
  const [sites, setSites] = useState<Sub2ApiSiteState[]>([]);
  useEffect(() => {
    if (!sub2ApiService) {
      setSites([]);
      return;
    }
    void sub2ApiService.getSites().then((state) => setSites(state.sites));
    const disposable = sub2ApiService.onDidChange((state) => setSites(state.sites));
    return () => disposable.dispose();
  }, [sub2ApiService]);
  const authedRelaySites = sites.filter((site) => site.account && site.enabled !== false);
  const relaySite =
    authedRelaySites.find((site) => site.siteId === selectedSiteId) ??
    (user ? null : (authedRelaySites[0] ?? null));
  return { user, authedRelaySites, relaySite, setRelaySiteSelection };
}
