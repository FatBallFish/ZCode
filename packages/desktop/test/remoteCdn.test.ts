import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isUtcPlusEightTimeZone,
  resolveRemoteCdnBaseUrls,
  shouldPreferDomesticRemoteCdn,
} from "../src/main/remoteCdn.js";

// custom 语义（spec specs/mikiko-cloud/agent-endpoint-plan.md §4.5）：远端组件下载
// 单一基址，MIKIKO_CDN_BASE_URL 环境变量优先，缺省回落自建分发域；不再做国内/海外
// CDN 双根排序。时区助手仍保留（供将来分区调度复用）并保持既有判定语义。

describe("remoteCdn", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("时区助手按 UTC 偏移判断而不是固定城市名单", () => {
    expect(isUtcPlusEightTimeZone("Asia/Shanghai")).toBe(true);
    expect(isUtcPlusEightTimeZone("Asia/Singapore")).toBe(true);
    expect(isUtcPlusEightTimeZone("Asia/Tokyo")).toBe(false);
    expect(shouldPreferDomesticRemoteCdn({ locale: "zh-CN", timeZone: "Asia/Shanghai" })).toBe(
      true,
    );
    expect(shouldPreferDomesticRemoteCdn({ locale: "en-US", timeZone: "Asia/Shanghai" })).toBe(
      false,
    );
  });

  it("缺省回落自建分发域并拼接版本路径", () => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "production",
        version: "0.0.0-test",
      }),
    ).toEqual(["https://agent-dl.mikiko.ai/mikiko/electron/releases/0.0.0-test"]);
  });

  it("MIKIKO_CDN_BASE_URL 优先于缺省基址", () => {
    vi.stubEnv("MIKIKO_CDN_BASE_URL", "https://cdn.mikiko.example/assets/");
    expect(
      resolveRemoteCdnBaseUrls({
        env: "production",
        version: "0.0.0-test",
      }),
    ).toEqual(["https://cdn.mikiko.example/assets/mikiko/electron/releases/0.0.0-test"]);
  });

  it("显式覆盖 CDN 基址时不再读取环境与缺省值，并归一化尾斜杠", () => {
    vi.stubEnv("MIKIKO_CDN_BASE_URL", "https://cdn.mikiko.example/assets/");
    expect(
      resolveRemoteCdnBaseUrls({
        env: "test",
        overrideBaseUrl: "https://cdn.example.com/releases///",
        version: "0.0.0-test",
      }),
    ).toEqual(["https://cdn.example.com/releases"]);
  });

  it("未传版本时使用当前应用版本", () => {
    const urls = resolveRemoteCdnBaseUrls({ env: "production" });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/mikiko\/electron\/releases\/[^/]+$/u);
  });
});
