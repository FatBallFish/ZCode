/* Mikiko 下载入口共享逻辑：按浏览器识别操作系统，返回推荐下载项。
 * 版本与安装包直链优先取 /api/v1/releases/latest（agent-update manifest 聚合，
 * 发版自动跟进）；接口失败时回落下方写死的静态值（保证官网永不挂空链接）。 */
"use strict";

/** 静态兜底（发版后若接口异常仍能下载上一版；正常情况被 latest 接口覆盖）。 */
const MIKIKO_FALLBACK = {
  macos: {
    label: "下载 macOS 版",
    url: "https://agent-dl.mikiko.ai/files/1.0.4/Mikiko-1.0.4-mac-x64.dmg",
    note: "通用安装包 · Apple Silicon / Intel",
  },
  windows: {
    label: "下载 Windows 版",
    url: "https://agent-dl.mikiko.ai/files/1.0.4/Mikiko-1.0.4-win-x64.exe",
    note: "x64 安装程序",
  },
  linux: {
    label: "下载 Linux 版（AppImage）",
    url: "https://agent-dl.mikiko.ai/files/1.0.4/Mikiko-1.0.4-linux-x86_64.AppImage",
    note: "免安装通用包 · 其他格式见下载页",
  },
};

let latestReleasePromise = null;

/** 拉取聚合版本数据（60s 边缘缓存）；失败返回 null，调用方回落静态值。 */
function fetchLatestRelease() {
  if (!latestReleasePromise) {
    latestReleasePromise = fetch("/api/v1/releases/latest", { credentials: "omit" })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
      .finally(() => {
        // 失败不缓存失败态：下次调用重试。
        latestReleasePromise
          .then((value) => {
            if (!value) latestReleasePromise = null;
          })
          .catch(() => undefined);
      });
  }
  return latestReleasePromise;
}

function fileUrlByKind(latest, kind) {
  if (!latest) return null;
  const match = (latest.files || []).find((file) => file.kind === kind);
  return match ? match.url : null;
}

function detectMikikoPlatform() {
  const uad = navigator.userAgentData;
  if (uad && typeof uad.platform === "string") {
    const platform = uad.platform.toLowerCase();
    if (platform === "macos") return "macos";
    if (platform === "windows") return "windows";
    if (platform === "chrome os" || platform === "android") return null;
    if (platform === "linux") return "linux";
  }
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|Mobile/i.test(ua)) return null;
  if (/Macintosh|Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux|X11|Ubuntu|Fedora/i.test(ua)) return "linux";
  return null;
}

const KIND_BY_OS = { macos: "macos-dmg", windows: "windows-exe", linux: "appimage" };

/**
 * 装配一个下载按钮（<a>）：识别到系统则直连对应安装包（点击即下载），
 * 识别失败回落到 /download 让用户手动选择。返回 Promise<{os, file, latest}>：
 * latest 为聚合版本数据（可能为 null=使用静态兜底），latest.version 供页面显示版本号。
 */
async function setupMikikoDownloadButton(button, options = {}) {
  const os = detectMikikoPlatform();
  const latest = await fetchLatestRelease();
  if (os && MIKIKO_FALLBACK[os]) {
    const dynamicUrl = latest ? fileUrlByKind(latest, KIND_BY_OS[os]) : null;
    const file = dynamicUrl ? { ...MIKIKO_FALLBACK[os], url: dynamicUrl } : MIKIKO_FALLBACK[os];
    button.href = file.url;
    button.setAttribute("download", "");
    button.textContent = (options.prefix ?? "") + file.label;
    button.classList.add("detected");
    return { os, file, latest };
  }
  button.href = "/download";
  button.textContent = (options.prefix ?? "") + "获取下载";
  button.classList.add("undetected");
  return { os: null, file: null, latest };
}
