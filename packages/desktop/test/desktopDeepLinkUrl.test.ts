import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isOAuthCallbackUrl,
  isPaymentCallbackUrl,
  isShareImportUrl,
  extractShareImportCode,
  isWorkspaceOpenUrl,
  extractWorkspaceOpenPath,
  extractDeepLinkUrlFromArgs,
} from "../src/main/desktopDeepLinkUrl.ts";

/** 双 scheme 解析（2026-09-28）：zcode:// 与 mikiko:// 走同一套 host 分发。 */
describe("深链双 scheme 解析", () => {
  it("分享导入：两种 scheme 均可识别并提取 code", () => {
    for (const scheme of ["zcode", "mikiko"]) {
      const url = new URL(`${scheme}://share/import?code=abc123`);
      assert.equal(isShareImportUrl(url), true, scheme);
      assert.equal(extractShareImportCode(url), "abc123", scheme);
    }
    assert.equal(isShareImportUrl(new URL("https://share/import?code=x")), false);
  });

  it("工作区打开：两种 scheme 均可识别并提取 path", () => {
    for (const scheme of ["zcode", "mikiko"]) {
      const url = new URL(`${scheme}://workspace/open?path=${encodeURIComponent("/tmp/p a")}`);
      assert.equal(isWorkspaceOpenUrl(url), true, scheme);
      assert.equal(extractWorkspaceOpenPath(url), "/tmp/p a", scheme);
    }
  });

  it("OAuth / 支付回调：zcode:// 保留（智谱三方链路），mikiko:// 同样可解析兜底", () => {
    assert.equal(isOAuthCallbackUrl(new URL("zcode://oauth/callback?code=1")), true);
    assert.equal(isOAuthCallbackUrl(new URL("mikiko://oauth/callback?code=1")), true);
    assert.equal(isPaymentCallbackUrl(new URL("zcode://payment/callback?token=t")), true);
    assert.equal(isPaymentCallbackUrl(new URL("mikiko://payment/callback?token=t")), true);
    // 非深链 scheme 不误判。
    assert.equal(isOAuthCallbackUrl(new URL("https://oauth/callback")), false);
  });

  it("参数提取正则同时匹配两种 scheme", () => {
    assert.equal(
      extractDeepLinkUrlFromArgs(["app", "mikiko://share/import?code=x"]),
      "mikiko://share/import?code=x",
    );
    assert.equal(
      extractDeepLinkUrlFromArgs(["app", "zcode://share/import?code=y"]),
      "zcode://share/import?code=y",
    );
  });
});
