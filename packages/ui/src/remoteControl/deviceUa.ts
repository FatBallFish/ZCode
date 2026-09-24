import { Laptop, Monitor, Smartphone } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * 设备 UA 解析（spec §21.8）：设备卡片据此展示形态图标、类型化文案与精简摘要。
 * 纯函数、零依赖 React，便于单测。
 */

/** 由 UA 推断设备形态：图标 + 平台名（标题/胶囊共用；解析失败返回 null 走「移动设备」文案）。 */
export function detectDevice(ua: string): { icon: LucideIcon; name: string | null } {
  const value = ua.toLowerCase();
  if (value.includes("android")) {
    return { icon: Smartphone, name: "Android" };
  }
  if (value.includes("iphone") || value.includes("ipad") || value.includes("ios")) {
    return { icon: Smartphone, name: "iOS" };
  }
  if (value.includes("mac")) {
    return { icon: Laptop, name: "Mac" };
  }
  if (value.includes("windows")) {
    return { icon: Monitor, name: "Windows" };
  }
  if (value.includes("linux")) {
    return { icon: Monitor, name: "Linux" };
  }
  return { icon: Smartphone, name: null };
}

/**
 * UA 精简摘要：「浏览器 版本 · 系统 版本」，避免整串 UA 撑破布局；
 * 完整 UA 经行尾 info 图标 hover 查看。
 */
export function parseUaSummary(ua: string): string {
  // 浏览器判定顺序敏感：Edge/Opera/国内厂商壳均基于 Chromium，须先于 Chrome 判定。
  let browser = "";
  const edge = ua.match(/Edg(?:e|A|iOS)?\/(\d+)/);
  const opera = ua.match(/(?:OPR|Opera)\/(\d+)/);
  const firefox = ua.match(/Firefox\/(\d+)/);
  const samsung = ua.match(/SamsungBrowser\/(\d+)/);
  const huawei = ua.match(/HuaweiBrowser\/(\d+)/);
  const miui = ua.match(/MiuiBrowser\/(\d+)/);
  const quark = ua.match(/Quark\/(\d+)/);
  const chrome = ua.match(/(?:Headless)?Chrome\/(\d+)/);
  const safari = ua.match(/Version\/(\d+)[\d.]*\s*Safari/);
  if (edge) {
    browser = `Edge ${edge[1]}`;
  } else if (opera) {
    browser = `Opera ${opera[1]}`;
  } else if (firefox) {
    browser = `Firefox ${firefox[1]}`;
  } else if (samsung) {
    browser = `Samsung Internet ${samsung[1]}`;
  } else if (huawei) {
    browser = `Huawei Browser ${huawei[1]}`;
  } else if (miui) {
    browser = `Mi Browser ${miui[1]}`;
  } else if (quark) {
    browser = `Quark ${quark[1]}`;
  } else if (chrome) {
    browser = `Chrome ${chrome[1]}`;
  } else if (safari) {
    browser = `Safari ${safari[1]}`;
  }

  let os = "";
  const android = ua.match(/Android\s([\d.]+)/);
  const ios = ua.match(/(?:iPhone OS|CPU OS)\s([\d_]+)/);
  const macos = ua.match(/Mac OS X\s([\d_]+)/);
  if (android) {
    os = `Android ${android[1]}`;
  } else if (ios) {
    os = `iOS ${ios[1]!.replace(/_/g, ".")}`;
  } else if (/Windows/.test(ua)) {
    os = "Windows";
  } else if (macos) {
    os = `macOS ${macos[1]!.replace(/_/g, ".")}`;
  } else if (/Linux/.test(ua)) {
    os = "Linux";
  }

  const parts = [browser, os].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : ua;
}
