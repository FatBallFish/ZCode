/**
 * Mikiko 官网版本数据（spec specs/mikiko-cloud/agent-endpoint-plan.md「版本数据实时化」）：
 *
 * - GET /api/v1/releases/latest：聚合 agent-update 三平台 manifest（electron-updater YAML）
 *   为一份 JSON（版本号、安装包直链、中文更新日志），供首页/下载页运行时渲染；
 *   内存缓存 60s + 边缘缓存 60s。写死在页面里的直链降级为该接口失败时的 fallback。
 * - GET /api/v1/releases/notes：官网更新日志历史（KV release-notes 桶，发版流水线自动追加）。
 * - PUT /api/v1/admin/release-notes：发版流水线写入（X-Publish-Token 鉴权，
 *   secret MIKIKO_RELEASE_PUBLISH_TOKEN，与 update-service 的发布令牌模式一致）。
 */

const MANIFEST_ENDPOINT = "https://agent-update.mikiko.ai";
const MANIFEST_PATH = "/api/v1/releases/electron/manifest";
const RELEASE_NOTES_PREFIX = "rn:";
const LATEST_CACHE_TTL_MS = 60_000;

interface ManifestFile {
  readonly kind:
    | "macos-dmg"
    | "macos-zip"
    | "macos-arm64-dmg"
    | "macos-arm64-zip"
    | "windows-exe"
    | "windows-arm64-exe"
    | "appimage"
    | "deb"
    | "rpm"
    | "arch";
  readonly url: string;
  readonly sizeBytes: number;
}

interface LatestReleasePayload {
  readonly version: string;
  readonly releaseDate: string | null;
  readonly releaseNotesZhCn: string;
  readonly files: readonly ManifestFile[];
}

interface ReleaseNoteRecord {
  readonly version: string;
  readonly date: string;
  readonly markdown: string;
}

export interface MikikoCloudReleaseEnv {
  MIKIKO_CLIENT_CONFIG: KVNamespace;
  MIKIKO_RELEASE_PUBLISH_TOKEN?: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/* ── manifest YAML 解析（仅覆盖 electron-updater latest*.yml 的实际形状） ── */

function parseManifest(yaml: string): {
  version: string;
  releaseDate: string | null;
  notes: string;
  files: Array<{ url: string; sizeBytes: number }>;
} {
  const lines = yaml.split("\n");
  let version = "";
  let releaseDate: string | null = null;
  let notes = "";
  const files: Array<{ url: string; sizeBytes: number }> = [];

  let index = 0;
  let pendingUrl: string | null = null;
  let inZhNotes = false;
  let inNotesBlock = false;
  const notesLines: string[] = [];

  while (index < lines.length) {
    const line = lines[index]!;
    const urlMatch = /^ {2}- url: (\S+)$/u.exec(line);
    if (urlMatch) {
      if (pendingUrl !== null) files.push({ url: pendingUrl, sizeBytes: 0 });
      pendingUrl = urlMatch[1]!;
      index += 1;
      continue;
    }
    const sizeMatch = /^ {4}size: (\d+)$/u.exec(line);
    if (sizeMatch && pendingUrl !== null) {
      files.push({ url: pendingUrl, sizeBytes: Number(sizeMatch[1]) });
      pendingUrl = null;
      index += 1;
      continue;
    }
    const versionMatch = /^version: (\S+)$/u.exec(line);
    if (versionMatch) {
      version = versionMatch[1]!;
      index += 1;
      continue;
    }
    const dateMatch = /^releaseDate: '?([^'\n]+)'?$/u.exec(line);
    if (dateMatch) {
      releaseDate = dateMatch[1]!.trim();
      index += 1;
      continue;
    }
    if (/^  zh-CN:$/u.test(line)) {
      inZhNotes = true;
      index += 1;
      continue;
    }
    if (inZhNotes && /^ {4}markdown: \|$/u.test(line)) {
      inNotesBlock = true;
      index += 1;
      continue;
    }
    if (inNotesBlock) {
      // 多行块：缩进 ≥6 空格的行属于正文；遇到更浅缩进的非空行即块结束。
      if (line.trim() === "" || /^ {6,}/u.test(line)) {
        notesLines.push(line.replace(/^ {6}/u, ""));
        index += 1;
        continue;
      }
      inNotesBlock = false;
      inZhNotes = false;
    }
    index += 1;
  }
  if (pendingUrl !== null) files.push({ url: pendingUrl, sizeBytes: 0 });

  notes = notesLines.join("\n").replace(/\s+$/u, "");
  return { version, releaseDate, notes, files };
}

function classifyManifestFile(url: string): ManifestFile["kind"] | null {
  if (url.endsWith(".dmg")) return "macos-dmg";
  if (url.endsWith(".zip")) return "macos-zip";
  if (url.endsWith(".exe")) return "windows-exe";
  if (url.endsWith(".AppImage")) return "appimage";
  if (url.endsWith(".deb")) return "deb";
  if (url.endsWith(".rpm")) return "rpm";
  if (url.endsWith(".pkg.tar.zst")) return "arch";
  return null;
}

const DOWNLOAD_ORIGIN = "https://agent-dl.mikiko.ai";

/** 按命名规则推导 arm64 安装包直链，HEAD agent-dl 验证存在才返回。 */
async function deriveArchFiles(version: string): Promise<ManifestFile[]> {
  const candidates: Array<{ kind: ManifestFile["kind"]; name: string }> = [
    { kind: "macos-arm64-dmg", name: `Mikiko-${version}-mac-arm64.dmg` },
    { kind: "macos-arm64-zip", name: `Mikiko-${version}-mac-arm64.zip` },
    { kind: "windows-arm64-exe", name: `Mikiko-${version}-win-arm64.exe` },
  ];
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const response = await fetch(`${DOWNLOAD_ORIGIN}/files/${version}/${candidate.name}`, {
          method: "HEAD",
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return null;
        const sizeHeader = response.headers.get("content-length");
        return {
          kind: candidate.kind,
          url: `${DOWNLOAD_ORIGIN}/files/${version}/${candidate.name}`,
          sizeBytes: sizeHeader ? Number.parseInt(sizeHeader, 10) || 0 : 0,
        } satisfies ManifestFile;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((file): file is ManifestFile => file !== null);
}

/* ── latest 聚合（内存缓存 60s） ── */

let latestCache: { at: number; payload: LatestReleasePayload } | null = null;

/** 测试专用：清空 latest 聚合缓存，保证用例间隔离。 */
export function resetLatestReleaseCacheForTest(): void {
  latestCache = null;
}

export async function handleReleasesRequest(
  request: Request,
  env: MikikoCloudReleaseEnv,
  pathname: string,
): Promise<Response> {
  if (pathname === "/api/v1/releases/latest") {
    if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);
    return latestResponse();
  }
  if (pathname === "/api/v1/releases/notes") {
    if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);
    return notesResponse(env);
  }
  if (pathname === "/api/v1/admin/release-notes") {
    if (request.method !== "PUT") return jsonResponse({ error: "method_not_allowed" }, 405);
    return putReleaseNotes(request, env);
  }
  return jsonResponse({ error: "not_found" }, 404);
}

function latestResponse(): Promise<Response> {
  const now = Date.now();
  if (latestCache && now - latestCache.at < LATEST_CACHE_TTL_MS) {
    return Promise.resolve(cacheableLatest(latestCache.payload));
  }
  return (async () => {
    const platforms = ["darwin-aarch64", "windows-x86_64", "linux-x86_64"];
    const manifests = await Promise.all(
      platforms.map(async (platform) => {
        const response = await fetch(
          `${MANIFEST_ENDPOINT}${MANIFEST_PATH}?platform=${platform}&channel=1`,
          {
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!response.ok) {
          throw new Error(`manifest ${platform} HTTP ${response.status}`);
        }
        return parseManifest(await response.text());
      }),
    );
    const primary = manifests[0]!;
    const versions = new Set(manifests.map((manifest) => manifest.version));
    if (versions.size > 1) {
      // 三平台版本不一致说明发布进行中（分步上传），拒绝聚合防止官网展示混合版本。
      throw new Error(`manifest 版本不一致: ${[...versions].join(",")}`);
    }
    const files = manifests
      .flatMap((manifest) => manifest.files)
      .map((file) => ({ ...file, kind: classifyManifestFile(file.url) }))
      .filter((file): file is ManifestFile & { url: string } => file.kind !== null)
      .map(({ kind, url, sizeBytes }) => ({ kind, url, sizeBytes }));
    // 架构专属直链推导（2026-09-29 官网分架构下载）：manifest（electron-updater 通道）
    // 只登记 x64 主链，arm64 安装包按构建命名规则（Mikiko-{v}-{mac|win}-arm64.*）生成
    // agent-dl 直链，HEAD 验证存在才输出——产物随发版上传 R2，缺失的版本自动不出现。
    const archKinds = await deriveArchFiles(primary.version);
    const knownKinds = new Set(files.map((file) => file.kind));
    for (const derived of archKinds) {
      if (!knownKinds.has(derived.kind)) files.push(derived);
    }
    const payload: LatestReleasePayload = {
      version: primary.version,
      releaseDate: primary.releaseDate,
      releaseNotesZhCn: primary.notes,
      files,
    };
    latestCache = { at: now, payload };
    return cacheableLatest(payload);
  })().catch(() => {
    // 上游不可用时回退最近一次成功聚合（若有），保证官网不闪断版本信息。
    if (latestCache) {
      return cacheableLatest(latestCache.payload);
    }
    return jsonResponse({ error: "upstream_unavailable" }, 503, { "cache-control": "no-store" });
  });
}

function cacheableLatest(payload: LatestReleasePayload): Response {
  return jsonResponse(payload, 200, { "cache-control": "public, max-age=60" });
}

/* ── 更新日志历史（KV） ── */

function compareVersionsDesc(left: string, right: string): number {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (b[index] ?? 0) - (a[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function notesResponse(env: MikikoCloudReleaseEnv): Promise<Response> {
  const list = await env.MIKIKO_CLIENT_CONFIG.list({ prefix: RELEASE_NOTES_PREFIX });
  const records: ReleaseNoteRecord[] = [];
  for (const key of list.keys) {
    const record = (await env.MIKIKO_CLIENT_CONFIG.get(
      key.name,
      "json",
    )) as ReleaseNoteRecord | null;
    if (record && typeof record.version === "string" && typeof record.markdown === "string") {
      records.push(record);
    }
  }
  records.sort((left, right) => compareVersionsDesc(left.version, right.version));
  return jsonResponse({ entries: records }, 200, { "cache-control": "public, max-age=60" });
}

async function putReleaseNotes(request: Request, env: MikikoCloudReleaseEnv): Promise<Response> {
  if (!env.MIKIKO_RELEASE_PUBLISH_TOKEN) {
    return jsonResponse({ error: "publish_not_configured" }, 503);
  }
  const token = request.headers.get("x-publish-token") ?? "";
  if (token !== env.MIKIKO_RELEASE_PUBLISH_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  let body: { version?: unknown; date?: unknown; markdown?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "bad_request" }, 400);
  }
  const version = typeof body.version === "string" ? body.version.trim() : "";
  const markdown = typeof body.markdown === "string" ? body.markdown.trim() : "";
  if (!/^\d+\.\d+\.\d+$/u.test(version) || !markdown) {
    return jsonResponse({ error: "invalid_payload" }, 400);
  }
  const date =
    typeof body.date === "string" && body.date.trim()
      ? body.date.trim()
      : new Date().toISOString().slice(0, 10);
  const record: ReleaseNoteRecord = { version, date, markdown };
  // 同版本重复发布按幂等覆盖处理（流水线重跑不产生重复条目）。
  await env.MIKIKO_CLIENT_CONFIG.put(`${RELEASE_NOTES_PREFIX}${version}`, JSON.stringify(record));
  return jsonResponse({ ok: true, version });
}
