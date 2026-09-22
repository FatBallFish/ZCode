/**
 * Sub2API 站点登录面板：邮箱密码 + Turnstile（站点开启时内嵌验证）+ 2FA 分支。
 * 供设置页「Mikiko 网关」分区与欢迎页登录项复用。账密登录为一等公民：
 * 登录后可获取余额、订阅与全部 API 密钥管理能力。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { Sub2ApiSiteState } from "@zcode/services";
import { ISub2ApiService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { TurnstileWidget } from "@/components/ui/TurnstileWidget.js";
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
}

export function Sub2ApiLoginPanel({
  sub2ApiService,
  siteId,
  panelBaseUrl,
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
