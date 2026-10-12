/**
 * ChatGPT usage / rate-limit 解析与归一（wham 接口响应、推理响应头族、429 响应体）。
 * 窗口归一规则（sub2api 验证口径）：两窗口 window_minutes 小者=5h、大者=7d；
 * 仅一个窗口 ≤360min 判 5h；additional_rate_limits 原样透出（30D、image_gen 等）。
 */

export interface ChatGPTUsageWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetAfterSeconds?: number;
  resetAt?: string;
}

export interface ChatGPTUsageSnapshot {
  updatedAt: string;
  window5h?: ChatGPTUsageWindow;
  window7d?: ChatGPTUsageWindow;
  additionalWindows: Array<{ name: string } & ChatGPTUsageWindow>;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  limitReached?: boolean;
}

interface RawRateLimitWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  window_minutes?: number;
  reset_after_seconds?: number;
  reset_at?: string | number;
}

interface RawRateLimit {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: RawRateLimitWindow | null;
  secondary_window?: RawRateLimitWindow | null;
}

interface RawUsagePayload {
  rate_limit?: RawRateLimit | null;
  additional_rate_limits?: Array<{ limit_name?: string; rate_limit?: RawRateLimit | null }> | null;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | null } | null;
}

function normalizeWindow(
  raw: RawRateLimitWindow | null | undefined,
): ChatGPTUsageWindow | undefined {
  if (!raw || typeof raw.used_percent !== "number") return undefined;
  const resetAt = normalizeResetAt(raw.reset_at);
  return {
    usedPercent: raw.used_percent,
    ...(typeof raw.limit_window_seconds === "number"
      ? { windowMinutes: Math.round(raw.limit_window_seconds / 60) }
      : typeof raw.window_minutes === "number"
        ? { windowMinutes: raw.window_minutes }
        : {}),
    ...(typeof raw.reset_after_seconds === "number"
      ? { resetAfterSeconds: raw.reset_after_seconds }
      : {}),
    ...(resetAt ? { resetAt } : {}),
  };
}

function normalizeResetAt(value: string | number | undefined): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

const FIVE_HOUR_WINDOW_MINUTES = 360;

/** 双窗口归一：小者 5h、大者 7d；单窗口 ≤360min 判 5h，否则 7d。 */
function normalizePrimarySecondaryWindows(
  primary: ChatGPTUsageWindow | undefined,
  secondary: ChatGPTUsageWindow | undefined,
): { window5h?: ChatGPTUsageWindow; window7d?: ChatGPTUsageWindow } {
  if (primary && secondary) {
    return (primary.windowMinutes ?? 0) <= (secondary.windowMinutes ?? 0)
      ? { window5h: primary, window7d: secondary }
      : { window5h: secondary, window7d: primary };
  }
  const single = primary ?? secondary;
  if (!single) return {};
  return (single.windowMinutes ?? 0) <= FIVE_HOUR_WINDOW_MINUTES
    ? { window5h: single }
    : { window7d: single };
}

/** wham/usage 响应 → 快照。解析失败的字段静默降级（snapshot 永不 throw）。 */
export function normalizeChatGPTUsagePayload(
  payload: unknown,
  now = new Date(),
): ChatGPTUsageSnapshot {
  const raw = (payload ?? {}) as RawUsagePayload;
  const rateLimit = raw.rate_limit ?? null;
  const windows = normalizePrimarySecondaryWindows(
    normalizeWindow(rateLimit?.primary_window),
    normalizeWindow(rateLimit?.secondary_window),
  );
  const additionalWindows: ChatGPTUsageSnapshot["additionalWindows"] = [];
  for (const entry of raw.additional_rate_limits ?? []) {
    const limit = entry?.rate_limit;
    const primary =
      normalizeWindow(limit?.primary_window) ?? normalizeWindow(limit?.secondary_window);
    if (primary) additionalWindows.push({ name: entry.limit_name ?? "additional", ...primary });
  }
  const credits = raw.credits;
  return {
    updatedAt: now.toISOString(),
    ...windows,
    additionalWindows,
    ...(credits
      ? {
          credits: {
            hasCredits: credits.has_credits === true,
            unlimited: credits.unlimited === true,
            ...(typeof credits.balance === "string" && credits.balance.trim()
              ? { balance: credits.balance.trim() }
              : {}),
          },
        }
      : {}),
    ...(typeof rateLimit?.limit_reached === "boolean"
      ? { limitReached: rateLimit.limit_reached }
      : {}),
  };
}

// ── 推理响应头族解析（官方 rate_limits.rs 口径） ──

export interface ChatGPTRateLimitHeaderSnapshot {
  activeLimit?: string;
  primary?: ChatGPTUsageWindow;
  secondary?: ChatGPTUsageWindow;
  hasCredits?: boolean;
  unlimitedCredits?: boolean;
  creditsBalance?: string;
  rateLimitReachedType?: string;
  promoMessage?: string;
}

function readHeader(
  headers: { get(name: string): string | null },
  name: string,
): string | undefined {
  const value = headers.get(name);
  return value != null && value.trim() !== "" ? value.trim() : undefined;
}

function parseWindowHeaders(
  headers: { get(name: string): string | null },
  prefix: string,
): ChatGPTUsageWindow | undefined {
  const usedPercent = readHeader(headers, `${prefix}-used-percent`);
  if (usedPercent == null) return undefined;
  const resetAfterSeconds = readHeader(headers, `${prefix}-reset-after-seconds`);
  const windowMinutes = readHeader(headers, `${prefix}-window-minutes`);
  const resetAt = readHeader(headers, `${prefix}-reset-at`);
  return {
    usedPercent: Number(usedPercent),
    ...(windowMinutes != null ? { windowMinutes: Number(windowMinutes) } : {}),
    ...(resetAfterSeconds != null ? { resetAfterSeconds: Number(resetAfterSeconds) } : {}),
    ...(resetAt != null && Number.isFinite(Number(resetAt))
      ? { resetAt: new Date(Number(resetAt) * 1000).toISOString() }
      : {}),
  };
}

/**
 * 解析限流头族。`x-codex-active-limit` 决定主头族前缀（如 codex / codex_secondary）；
 * 未提供时按默认 `x-codex-primary/secondary-*` 解析。
 */
export function parseChatGPTRateLimitHeaders(headers: {
  get(name: string): string | null;
}): ChatGPTRateLimitHeaderSnapshot | undefined {
  const activeLimit = readHeader(headers, "x-codex-active-limit");
  // 头族前缀 = x-{limit_id}，limit id 中的下划线归一为连字符（官方 _→- 口径）。
  const prefix = activeLimit ? `x-${activeLimit.replace(/_/gu, "-")}` : "x-codex";
  const primary =
    parseWindowHeaders(headers, `${prefix}-primary`) ?? parseWindowHeaders(headers, `${prefix}`);
  const secondary =
    parseWindowHeaders(headers, `${prefix}-secondary`) ??
    parseWindowHeaders(headers, `${prefix}-secondary-primary`);
  const hasCredits = readHeader(headers, "x-codex-credits-has-credits");
  const unlimited = readHeader(headers, "x-codex-credits-unlimited");
  const balance = readHeader(headers, "x-codex-credits-balance");
  const reachedType = readHeader(headers, "x-codex-rate-limit-reached-type");
  const promo = readHeader(headers, "x-codex-promo-message");
  if (
    !primary &&
    !secondary &&
    hasCredits == null &&
    unlimited == null &&
    balance == null &&
    reachedType == null
  ) {
    return undefined;
  }
  return {
    ...(activeLimit ? { activeLimit } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(hasCredits != null ? { hasCredits: hasCredits === "true" || hasCredits === "1" } : {}),
    ...(unlimited != null ? { unlimitedCredits: unlimited === "true" || unlimited === "1" } : {}),
    ...(balance != null ? { creditsBalance: balance } : {}),
    ...(reachedType ? { rateLimitReachedType: reachedType } : {}),
    ...(promo ? { promoMessage: promo } : {}),
  };
}

/** 用头族快照合并更新 usage 快照（被动更新路径；仅覆盖出现的字段）。 */
export function mergeChatGPTRateLimitHeadersIntoUsage(
  usage: ChatGPTUsageSnapshot | undefined,
  headers: ChatGPTRateLimitHeaderSnapshot,
  now = new Date(),
): ChatGPTUsageSnapshot {
  const base: ChatGPTUsageSnapshot = usage ?? {
    updatedAt: now.toISOString(),
    additionalWindows: [],
  };
  const windows = normalizePrimarySecondaryWindows(
    headers.primary ?? base.window5h,
    headers.secondary ?? base.window7d,
  );
  return {
    ...base,
    ...windows,
    updatedAt: now.toISOString(),
    ...(headers.hasCredits != null || headers.creditsBalance != null
      ? {
          credits: {
            hasCredits: headers.hasCredits ?? base.credits?.hasCredits ?? false,
            unlimited: headers.unlimitedCredits ?? base.credits?.unlimited ?? false,
            ...((headers.creditsBalance ?? base.credits?.balance)
              ? { balance: headers.creditsBalance ?? base.credits?.balance }
              : {}),
          },
        }
      : {}),
  };
}

// ── 429 usage_limit_reached 响应体（官方 api_bridge 口径） ──

export interface ChatGPTUsageLimitBody {
  planType?: string;
  resetsAt?: string;
  limitWindowMinutes?: number;
}

export function parseChatGPTUsageLimitBody(bodyText: string): ChatGPTUsageLimitBody | undefined {
  try {
    const body = JSON.parse(bodyText) as {
      error?: {
        type?: string;
        plan_type?: string;
        resets_at?: number;
        limit_window_minutes?: number;
      };
    };
    const error = body?.error;
    if (!error) return undefined;
    return {
      ...(error.plan_type ? { planType: error.plan_type } : {}),
      ...(typeof error.resets_at === "number" && Number.isFinite(error.resets_at)
        ? { resetsAt: new Date(error.resets_at * 1000).toISOString() }
        : {}),
      ...(typeof error.limit_window_minutes === "number"
        ? { limitWindowMinutes: error.limit_window_minutes }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * credits 余额展示格式化：wham/rate-limit-reset-credits 返回的 balance 是
 * "62500.0000000000" 这类定点字符串，直接渲染会把多余小数暴露给用户。
 * 整数去掉小数位，非整数最多保留 2 位；无法解析时原样返回。
 */
export function formatChatGPTCreditsBalance(balance: string | null | undefined): string | null {
  if (balance == null || balance.trim() === "") return null;
  const value = Number(balance);
  if (!Number.isFinite(value)) return balance;
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}
