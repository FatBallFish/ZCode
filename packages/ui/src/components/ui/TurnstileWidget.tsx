/**
 * Cloudflare Turnstile 内嵌组件。
 * 按 sub2api 新前端的 explicit 模式实现：按需注入 script（id 标记防重复）、
 * render 到容器 div、callback 取一次性 token；每次提交后由调用方 reset()。
 */
import { useEffect, useRef } from "react";

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      language?: string;
      theme?: "auto" | "light" | "dark";
      size?: "flexible" | "normal" | "compact";
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: (errorCode: string) => void;
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const TURNSTILE_SCRIPT_ID = "mikiko-turnstile-script";
const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptLoadingPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  if (scriptLoadingPromise) {
    return scriptLoadingPromise;
  }
  const pendingPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID);
    if (existing && !(existing instanceof HTMLScriptElement)) {
      reject(new Error("Turnstile script ID is already used by another element."));
      return;
    }
    const script = existing ?? document.createElement("script");
    const removeListeners = () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    };
    const handleLoad = () => {
      removeListeners();
      if (window.turnstile) {
        resolve(window.turnstile);
      } else {
        script.remove();
        reject(new Error("Turnstile API was unavailable after the script loaded."));
      }
    };
    const handleError = () => {
      removeListeners();
      if (!existing) {
        script.remove();
      }
      reject(new Error("Failed to load the Turnstile script."));
    };
    script.addEventListener("load", handleLoad);
    script.addEventListener("error", handleError);
    if (!existing) {
      script.id = TURNSTILE_SCRIPT_ID;
      script.setAttribute("src", TURNSTILE_SCRIPT_URL);
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
  scriptLoadingPromise = pendingPromise.then(
    (turnstile) => {
      scriptLoadingPromise = null;
      return turnstile;
    },
    (error: unknown) => {
      scriptLoadingPromise = null;
      throw error;
    },
  );
  return scriptLoadingPromise;
}

export interface TurnstileWidgetProps {
  siteKey: string;
  locale: string;
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: (message: string) => void;
  /** 暴露给父组件的 reset 句柄；登录失败后必须 reset（token 一次性）。 */
  registerReset?: (reset: () => void) => void;
}

export function TurnstileWidget({
  siteKey,
  locale,
  onVerify,
  onExpire,
  onError,
  registerReset,
}: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<TurnstileApi | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);
  const onErrorRef = useRef(onError);
  const registerResetRef = useRef(registerReset);

  onVerifyRef.current = onVerify;
  onExpireRef.current = onExpire;
  onErrorRef.current = onError;
  registerResetRef.current = registerReset;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled) {
          return;
        }
        try {
          const widgetId = turnstile.render(container, {
            sitekey: siteKey,
            language: locale,
            theme: "auto",
            size: "flexible",
            callback: (token) => onVerifyRef.current(token),
            "expired-callback": () => onExpireRef.current?.(),
            "error-callback": () => onErrorRef.current?.("人机验证出错，请重试"),
          });
          apiRef.current = turnstile;
          widgetIdRef.current = widgetId;
          registerResetRef.current?.(() => {
            if (widgetIdRef.current) {
              turnstile.reset(widgetIdRef.current);
            }
          });
        } catch (error) {
          onErrorRef.current?.(error instanceof Error ? error.message : "Turnstile 初始化失败");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          onErrorRef.current?.(error instanceof Error ? error.message : "Turnstile 脚本加载失败");
        }
      });
    return () => {
      cancelled = true;
      if (widgetIdRef.current) {
        apiRef.current?.remove(widgetIdRef.current);
        widgetIdRef.current = null;
        apiRef.current = null;
      }
    };
  }, [siteKey, locale]);

  return <div ref={containerRef} style={{ minHeight: "65px", width: "100%" }} />;
}
