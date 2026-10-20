import { ZCODE_VERSION, type ZCodeEnv } from "@zcode/shared";

declare const __ZCODE_CDN_BASE_URL__: string | undefined;

export interface ResolveRemoteCdnOptions {
  env?: ZCodeEnv;
  locale?: string;
  timeZone?: string;
  overrideBaseUrl?: string;
  version?: string;
  now?: Date;
}

function isChineseLocale(locale?: string | null): boolean {
  return locale?.trim().toLowerCase().startsWith("zh") ?? false;
}

function resolveLocalTimeZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function isUtcPlusEightTimeZone(timeZone?: string | null, now: Date = new Date()): boolean {
  const normalizedTimeZone = timeZone?.trim();
  if (!normalizedTimeZone) {
    return false;
  }

  const offsetMinutes = resolveTimeZoneOffsetMinutes(normalizedTimeZone, now);
  return offsetMinutes === 8 * 60;
}

export function shouldPreferDomesticRemoteCdn(
  options: Pick<ResolveRemoteCdnOptions, "locale" | "timeZone" | "now">,
): boolean {
  const timeZone = options.timeZone ?? resolveLocalTimeZone();
  return isChineseLocale(options.locale) && isUtcPlusEightTimeZone(timeZone, options.now);
}

/** 缺省远端组件下载基址：Mikiko 自建分发域（spec specs/update/update-service.md）。 */
const DEFAULT_CDN_BASE_URL = "https://agent-dl.mikiko.ai";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/u, "");
}

function resolveTimeZoneOffsetMinutes(timeZone: string, now: Date): number {
  // 用 Intl 在指定时区的给定时刻格式化出偏移（如 GMT+08:00），再解析为分钟。
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).format(now);
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(formatted);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

export function resolveRemoteCdnBaseUrls(options: ResolveRemoteCdnOptions = {}): string[] {
  const override = options.overrideBaseUrl?.trim();
  if (override) return [normalizeBaseUrl(override)];
  const baseUrl =
    process.env.MIKIKO_CDN_BASE_URL?.trim() ||
    (typeof __ZCODE_CDN_BASE_URL__ === "undefined" ? "" : __ZCODE_CDN_BASE_URL__) ||
    DEFAULT_CDN_BASE_URL;
  // 新Source Server发布使用品牌路径；沿用旧/zcode根会漏掉已上传的descriptor且不能回退官方。
  return [
    `${normalizeBaseUrl(baseUrl)}/mikiko/electron/releases/${options.version ?? ZCODE_VERSION}`,
  ];
}
