/**
 * 欢迎页中转站登录块：MikikoCC 直登；Sub2api 先验证 BaseURL 再登。
 * 登录成功后由父组件关闭欢迎页（中转站账号 + 激活密钥即构成可用模型配置）。
 */
import { useCallback, useEffect, useState } from "react";

import type { Sub2ApiSiteState, Sub2ApiSitesState } from "@zcode/services";
import { ISub2ApiService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { Sub2ApiLoginPanel } from "@/settings/Sub2ApiLoginPanel.js";

const inputClassName =
  "flex h-8 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none";

export interface WelcomeSub2ApiLoginProps {
  variant: "mikikocc" | "sub2api";
  onCancel: () => void;
  onLoggedIn: () => void;
}

export function WelcomeSub2ApiLogin({ variant, onCancel, onLoggedIn }: WelcomeSub2ApiLoginProps) {
  const { intl } = useZCodeIntl();
  const baseServices = useBaseWorkspaceServices();
  const sub2ApiService = baseServices?.sub2ApiService as ISub2ApiService | undefined;
  const [sites, setSites] = useState<Sub2ApiSitesState | null>(null);
  const [boundSiteId, setBoundSiteId] = useState<string | null>(null);
  const [siteUrl, setSiteUrl] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sub2ApiService) {
      return;
    }
    void sub2ApiService.getSites().then(setSites);
  }, [sub2ApiService]);

  const handleAddSite = useCallback(async () => {
    if (!sub2ApiService) {
      return;
    }
    setBusy(true);
    try {
      // 同地址站点已存在则直接复用（覆盖登录）；否则新建占位记录并绑定地址。
      const normalized = siteUrl.trim().replace(/\/+$/, "");
      const existing = (sites?.sites ?? []).find(
        (entry) => entry.kind === "sub2api" && entry.panelBaseUrl === normalized,
      );
      if (existing) {
        setBoundSiteId(existing.siteId);
        return;
      }
      const placeholder = await sub2ApiService.addSite("about:blank");
      await sub2ApiService.bindSiteAddress(placeholder.siteId, siteUrl);
      setBoundSiteId(placeholder.siteId);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [sub2ApiService, siteUrl, sites]);

  if (!sub2ApiService) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          {intl.formatMessage({ id: "settings.sub2api.unavailable" })}
        </p>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {intl.formatMessage({ id: "common.back" })}
        </Button>
      </div>
    );
  }

  const handleLoggedIn = (_state: Sub2ApiSiteState) => {
    onLoggedIn();
  };

  if (variant === "mikikocc") {
    const site = sites?.sites.find((entry) => entry.kind === "mikikocc");
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {intl.formatMessage({ id: "login.sub2api.mikikocc.hint" })}
        </p>
        {site && (
          <Sub2ApiLoginPanel
            sub2ApiService={sub2ApiService}
            siteId={site.siteId}
            panelBaseUrl={site.panelBaseUrl}
            onLoggedIn={handleLoggedIn}
            onCancel={onCancel}
          />
        )}
      </div>
    );
  }

  // Sub2api 模式始终走"新增站点"流：填地址校验 → 直接登录；若同地址站点已存在则覆盖登录。
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {intl.formatMessage({ id: "login.sub2api.sub2api.hint" })}
      </p>
      <input
        className={inputClassName}
        placeholder="https://your-sub2api-site.com"
        value={siteUrl}
        onChange={(event) => setSiteUrl(event.target.value)}
      />
      {boundSiteId ? (
        <Sub2ApiLoginPanel
          sub2ApiService={sub2ApiService}
          siteId={boundSiteId}
          panelBaseUrl={siteUrl}
          onLoggedIn={handleLoggedIn}
          onCancel={onCancel}
        />
      ) : (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={busy || siteUrl.trim().length < 8}
            onClick={() => void handleAddSite()}
          >
            {intl.formatMessage({ id: "settings.sub2api.site.add" })}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        </div>
      )}
    </div>
  );
}
