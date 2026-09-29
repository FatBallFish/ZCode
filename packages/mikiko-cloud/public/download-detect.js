/* Mikiko 下载入口共享逻辑：按浏览器识别操作系统与架构，返回推荐下载项。
 * 版本与安装包直链优先取 /api/v1/releases/latest（agent-update manifest 聚合，
 * 发版自动跟进）；接口失败时回落下方写死的静态值（保证官网永不挂空链接）。
 * 文案双语（LABELS.zh / LABELS.en），页面经 options.locale 选择，缺省中文。 */
"use strict";

const LABELS = {
  zh: {
    macos: { label: "下载 macOS 版", note: "通用安装包 · Apple Silicon / Intel" },
    windows: { label: "下载 Windows 版", note: "x64 安装程序" },
    linux: { label: "下载 Linux 版（AppImage）", note: "免安装通用包 · 其他格式见下载页" },
    fallback: "获取下载",
    arch: {
      arm64: "arm64（Apple 芯片 / Windows on ARM）",
      x64: "x64（Intel / AMD）",
      unknown: "通用安装包 · Apple Silicon / Intel",
    },
  },
  en: {
    macos: { label: "Download for macOS", note: "Universal build · Apple Silicon / Intel" },
    windows: { label: "Download for Windows", note: "x64 installer" },
    linux: {
      label: "Download for Linux (AppImage)",
      note: "portable universal package · other formats on the download page",
    },
    fallback: "Get downloads",
    arch: {
      arm64: "arm64 (Apple silicon / Windows on ARM)",
      x64: "x64 (Intel / AMD)",
      unknown: "Universal build · Apple Silicon / Intel",
    },
  },
};

function labelsFor(locale) {
  return locale === "en" ? LABELS.en : LABELS.zh;
}

/** 静态兜底（latest 接口失败时；正常情况被动态直链覆盖）。 */
const MIKIKO_FALLBACK = {
  macos: { url: "https://agent-dl.mikiko.ai/files/1.0.4/Mikiko-1.0.4-mac-x64.dmg" },
  windows: { url: "https://agent-dl.mikiko.ai/files/1.0.4/Mikiko-1.0.4-win-x64.exe" },
  linux: { url: "https://agent-dl.mikiko.ai/files/1.0.4/Mikiko-1.0.4-linux-x86_64.AppImage" },
};

let latestReleasePromise = null;

/** 拉取聚合版本数据（60s 边缘缓存）；失败返回 null 并清缓存供下次重试。 */
function fetchLatestRelease() {
  if (!latestReleasePromise) {
    latestReleasePromise = fetch("/api/v1/releases/latest", { credentials: "omit" })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
    latestReleasePromise
      .then((value) => {
        if (!value) latestReleasePromise = null;
      })
      .catch(() => undefined);
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

/** 架构探测：返回 "arm64" | "x64" | null（null=未知，回落通用包/手动选择）。
 *  优先 UA-CH 高熵 architecture（Chromium/Edge）；Safari 无 UA-CH 时用
 *  WebGL 渲染器字符串兜底（Apple Silicon 统一 GPU 标识 "Apple M*" / "Apple GPU"）。 */
async function detectMikikoArch(os) {
  try {
    const uad = navigator.userAgentData;
    if (uad && typeof uad.getHighEntropyValues === "function") {
      const values = await uad.getHighEntropyValues(["architecture", "bitness"]);
      const arch = (values.architecture || "").toLowerCase();
      if (arch === "arm" || arch === "arm64") return "arm64";
      if (arch === "x86" || arch === "x86_64" || arch === "amd64") return "x64";
    }
  } catch {
    /* UA-CH 不可用时走 WebGL 兜底 */
  }
  if (os === "macos") {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "") : "";
      if (/Apple (M\d|GPU)/i.test(renderer)) return "arm64";
      if (/Intel|AMD|Radeon|NVIDIA|GeForce/i.test(renderer)) return "x64";
    } catch {
      /* WebGL 不可用 */
    }
  }
  if (/arm64|aarch64/i.test(navigator.userAgent)) return "arm64";
  return null;
}

/** OS + 架构 → 下载 kind。arm 产物缺失（旧版本无 win-arm64）时回落 x64。 */
function resolveDownloadKind(os, arch, availableKinds) {
  if (os === "macos") {
    if (arch === "arm64" && availableKinds.has("macos-arm64-dmg")) return "macos-arm64-dmg";
    return "macos-dmg";
  }
  if (os === "windows") {
    if (arch === "arm64" && availableKinds.has("windows-arm64-exe")) return "windows-arm64-exe";
    return "windows-exe";
  }
  return "appimage";
}

/**
 * 装配一个下载按钮（<a>）：识别到系统则直连对应安装包（点击即下载），
 * 识别失败回落到下载页让用户手动选择。返回 Promise<{os, arch, file, latest}>。
 */
async function setupMikikoDownloadButton(button, options = {}) {
  const t = labelsFor(options.locale);
  const os = detectMikikoPlatform();
  const latest = await fetchLatestRelease();
  if (os && MIKIKO_FALLBACK[os]) {
    const availableKinds = new Set((latest && latest.files ? latest.files : []).map((f) => f.kind));
    const arch = os === "linux" ? null : await detectMikikoArch(os);
    const kind = latest
      ? resolveDownloadKind(os, arch, availableKinds)
      : os === "macos"
        ? "macos-dmg"
        : os === "windows"
          ? "windows-exe"
          : "appimage";
    const dynamicUrl = latest ? fileUrlByKind(latest, kind) : null;
    const base = MIKIKO_FALLBACK[os];
    const note = os === "linux" ? t.linux.note : arch ? t.arch[arch] : t.arch.unknown;
    const file = {
      ...base,
      ...(dynamicUrl ? { url: dynamicUrl } : {}),
      note,
      label: t[os].label,
    };
    button.href = file.url;
    button.setAttribute("download", "");
    button.textContent = (options.prefix ?? "") + file.label;
    button.classList.add("detected");
    return { os, arch, file, latest };
  }
  button.href = options.fallbackPath ?? "/download";
  button.textContent = (options.prefix ?? "") + t.fallback;
  button.classList.add("undetected");
  return { os: null, arch: null, file: null, latest };
}

// 供下载页弹层逻辑复用（window.MikikoDownload 命名空间）。
window.MikikoDownload = {
  labelsFor,
  detectMikikoPlatform,
  detectMikikoArch,
  resolveDownloadKind,
  fetchLatestRelease,
  setupMikikoDownloadButton,
};
