/**
 * Sub2API 站点登录面板。按站点类型分流（2026-10-20 批次 2，方案 Part A）：
 * - method="oidc"（仅 MikikoCC）：Mikiko ID（KeyCloak OIDC）浏览器授权登录——
 *   用户裁定 MikikoCC 彻底移除账密，全入口（欢迎页 + 设置页）一致。
 * - method="password"（sub2api 自建站点）：邮箱密码 + Turnstile + 2FA 原样保留。
 * 供设置页「Mikiko 网关」分区与欢迎页登录项复用。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { Sub2ApiSiteState } from "@zcode/services";
import { ISub2ApiService } from "@zcode/services";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { TurnstileWidget } from "@/components/ui/TurnstileWidget.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

const inputClassName =
  "flex h-8 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none";

export interface Sub2ApiLoginPanelProps {
  sub2ApiService: ISub2ApiService;
  siteId: string;
  panelBaseUrl: string;
  onLoggedIn: (state: Sub2ApiSiteState) => void;
  onCancel?: () => void;
  /** mikikocc → OIDC；sub2api → 账密。缺省 password（存量 sub2api 站点行为不变）。 */
  method?: "oidc" | "password";
}

/** 登录成功但模型列表同步失败：不阻断进入已登录态，toast 提示（服务层已安排延迟重试）。 */
function notifySyncError(
  syncError: string | undefined,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): void {
  if (!syncError) {
    return;
  }
  toast(intl.formatMessage({ id: "settings.sub2api.login.syncFailed" }), { variant: "warning" });
}

export function Sub2ApiLoginPanel(props: Sub2ApiLoginPanelProps) {
  if (props.method === "oidc") {
    return <MikikoOidcLoginPanel {...props} />;
  }
  return <PasswordLoginPanel {...props} />;
}

/** MikikoCC：Mikiko ID（OIDC）浏览器授权登录。 */
function MikikoOidcLoginPanel({
  sub2ApiService,
  siteId,
  onLoggedIn,
  onCancel,
}: Sub2ApiLoginPanelProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    const disposeCompleted = sub2ApiService.onOIDCLoginCompleted((event) => {
      if (event.siteId !== siteId) return;
      setWaiting(false);
      setBusy(false);
      notifySyncError(event.syncError, intl);
      onLoggedIn(event.state);
    });
    const disposeFailed = sub2ApiService.onOIDCLoginFailed((event) => {
      if (event.siteId !== siteId) return;
      setWaiting(false);
      setBusy(false);
      setErrorText(
        event.message || intl.formatMessage({ id: "settings.sub2api.login.oidc.failed" }),
      );
    });
    return () => {
      disposeCompleted.dispose();
      disposeFailed.dispose();
    };
  }, [sub2ApiService, siteId, onLoggedIn, intl]);

  const start = useCallback(async () => {
    setBusy(true);
    setErrorText(null);
    try {
      const session = await sub2ApiService.startOIDCLogin(siteId);
      platform.openExternal(session.authorizeUrl);
      setWaiting(true);
    } catch (error) {
      setErrorText(
        error instanceof Error
          ? error.message
          : intl.formatMessage({ id: "settings.sub2api.login.oidc.failed" }),
      );
    } finally {
      setBusy(false);
    }
  }, [sub2ApiService, siteId, platform, intl]);

  // 取消只回到按钮态（用户可重试或改走其它登录方式），不关闭宿主面板。
  const cancel = useCallback(async () => {
    await sub2ApiService.cancelOIDCLogin(siteId).catch((error: unknown) => {
      logger.warn("[sub2api] 取消 Mikiko ID 登录失败", { siteId, error: String(error) });
    });
    setWaiting(false);
  }, [sub2ApiService, siteId]);

  return (
    <div className="space-y-2">
      {waiting ? (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-foreground-subtle" />
          <span className="text-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.sub2api.login.oidc.waiting" })}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void cancel()}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void start()}>
            {intl.formatMessage({ id: "settings.sub2api.login.oidc.submit" })}
          </Button>
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          )}
        </div>
      )}
      {errorText && <p className="text-sm text-destructive">{errorText}</p>}
    </div>
  );
}

/** sub2api 自建站点：邮箱密码 + Turnstile（站点开启时内嵌验证）+ 2FA 分支。 */
function PasswordLoginPanel({
  sub2ApiService,
  siteId,
  onLoggedIn,
  onCancel,
}: Sub2ApiLoginPanelProps) {
  const { intl, locale } = useZCodeIntl();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [twoFactor, setTwoFactor] = useState<{ tempToken: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const resetTurnstileRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    sub2ApiService
      .getPublicSettings(siteId)
      .then((settings) => {
        if (cancelled) {
          return;
        }
        setTurnstileSiteKey(
          settings.turnstileEnabled && settings.turnstileSiteKey ? settings.turnstileSiteKey : null,
        );
      })
      .catch((error: unknown) => {
        logger.warn("[sub2api] 公开配置读取失败", { siteId, error: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [sub2ApiService, siteId]);

  const afterAttempt = useCallback(() => {
    setTurnstileToken(null);
    resetTurnstileRef.current?.();
  }, []);

  const submitLogin = useCallback(async () => {
    setBusy(true);
    setErrorText(null);
    try {
      const result = await sub2ApiService.login({
        siteId,
        email,
        password,
        turnstileToken: turnstileToken ?? undefined,
      });
      setPassword("");
      notifySyncError(result.syncError, intl);
      onLoggedIn(result.state);
    } catch (error) {
      const errorCode = (error as { errorCode?: string }).errorCode;
      if (errorCode === "captcha") {
        setErrorText(intl.formatMessage({ id: "settings.sub2api.login.captchaFailed" }));
      } else if (errorCode === "invalid-credential") {
        setErrorText(intl.formatMessage({ id: "settings.sub2api.login.invalidCredential" }));
      } else if (errorCode === "requires-2fa") {
        const tempToken = (error as { tempToken?: string }).tempToken;
        if (tempToken) {
          setTwoFactor({ tempToken });
          setErrorText(null);
        } else {
          setErrorText(intl.formatMessage({ id: "settings.sub2api.login.failed" }));
        }
      } else {
        setErrorText(
          error instanceof Error
            ? error.message
            : intl.formatMessage({ id: "settings.sub2api.login.failed" }),
        );
      }
    } finally {
      afterAttempt();
      setBusy(false);
    }
  }, [sub2ApiService, siteId, email, password, turnstileToken, onLoggedIn, intl, afterAttempt]);

  const submit2FA = useCallback(async () => {
    if (!twoFactor) {
      return;
    }
    setBusy(true);
    setErrorText(null);
    try {
      const result = await sub2ApiService.loginWith2FA({
        siteId,
        tempToken: twoFactor.tempToken,
        totpCode,
      });
      setPassword("");
      setTotpCode("");
      setTwoFactor(null);
      notifySyncError(result.syncError, intl);
      onLoggedIn(result.state);
    } catch (error) {
      setErrorText(
        error instanceof Error
          ? error.message
          : intl.formatMessage({ id: "settings.sub2api.login.failed" }),
      );
    } finally {
      setBusy(false);
    }
  }, [sub2ApiService, siteId, twoFactor, totpCode, onLoggedIn, intl]);

  const turnstileRequired = turnstileSiteKey !== null;

  return (
    <div className="space-y-3">
      {twoFactor ? (
        <div className="space-y-2">
          <input
            className={inputClassName}
            inputMode="numeric"
            placeholder={intl.formatMessage({ id: "settings.sub2api.login.totpPlaceholder" })}
            value={totpCode}
            onChange={(event) => setTotpCode(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={busy || totpCode.trim().length < 6}
              onClick={() => void submit2FA()}
            >
              {intl.formatMessage({ id: "settings.sub2api.login.submit" })}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setTwoFactor(null)}>
              {intl.formatMessage({ id: "common.back" })}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <input
            className={inputClassName}
            type="email"
            placeholder={intl.formatMessage({ id: "settings.sub2api.login.email" })}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <input
            className={inputClassName}
            type="password"
            placeholder={intl.formatMessage({ id: "settings.sub2api.login.password" })}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {turnstileRequired && (
            <TurnstileWidget
              siteKey={turnstileSiteKey ?? ""}
              locale={locale}
              onVerify={(token) => setTurnstileToken(token)}
              onExpire={() => setTurnstileToken(null)}
              onError={(message) => setErrorText(message)}
              registerReset={(reset) => {
                resetTurnstileRef.current = reset;
              }}
            />
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={busy || !email || !password || (turnstileRequired && !turnstileToken)}
              onClick={() => void submitLogin()}
            >
              {intl.formatMessage({ id: "settings.sub2api.login.submit" })}
            </Button>
            {onCancel && (
              <Button variant="ghost" size="sm" onClick={onCancel}>
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
            )}
          </div>
        </div>
      )}
      {errorText && <p className="text-sm text-destructive">{errorText}</p>}
    </div>
  );
}
