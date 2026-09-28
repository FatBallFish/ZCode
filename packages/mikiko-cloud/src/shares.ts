/* eslint-disable max-lines -- 分享协议的服务端实现（路由、设备注册、限流、四阶段发布与公开读）必须共享同一份 KV 记录形状与错误码表，拆分会引入多条状态写入路径。 */
/**
 * Mikiko 自建对话分享（spec specs/mikiko-cloud/agent-endpoint-plan.md §4.3）。
 *
 * 协议与客户端 ConversationShareHttpClient 兼容（四阶段：capabilities → preparations →
 * artifacts → confirm；公开侧 preview/continuation）。发布侧鉴权为设备级 token
 * （POST /api/v1/shares/device/register，deviceId 是客户端 deviceMid 的 sha256，原始值不出网），
 * 限流按 IP 每分钟 N 次（阈值从 MIKIKO_CLIENT_CONFIG KV 下发的 share.publishPerMinutePerIp 读取，
 * 服务端强制执行）。存储：KV（设备/预发布/分享元数据与 rows）+ R2（artifacts 按 sha256 寻址）。
 *
 * 错误信封 {code, msg} 沿用客户端已知码表（3201 鉴权、3002 限流、3203/3204 契约、
 * 3205 会话无效、3206 需确认披露、3208 结果物不允许、3209 超限、3211 不存在、3212 过期）。
 */

const DEVICE_ID_PATTERN = /^[0-9a-f]{16,128}$/u;
const SHARE_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SHARE_CODE_LENGTH = 10;
const PREPARATION_TTL_MS = 60 * 60 * 1000;
const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IMPORT_GRANT_TTL_MS = 10 * 60 * 1000;
const MAX_ROWS = 4000;
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
const MAX_ARTIFACT_COUNT = 20;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 200 * 1024 * 1024;
const DEFAULT_SHARE_RATE_LIMIT_PER_MINUTE = 3;
const DEFAULT_REGISTER_RATE_LIMIT_PER_MINUTE = 10;
const DEFAULT_PUBLISH_STEP_RATE_LIMIT_PER_MINUTE = 30;
const DEVICE_RECORD_TTL_SECONDS = 180 * 24 * 60 * 60;
/** 同一设备并存的有效 secret 上限（多进程/重注册不互踢，超限淘汰最旧）。 */
const DEVICE_SECRET_LIMIT = 5;
/** private 分享的访问口令字符集与长度（去掉易混淆的 0/O/1/I/l）。 */
const SHARE_PWD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SHARE_PWD_LENGTH = 8;

const ACCESS_MODES = ["private", "public_readonly", "public_importable"] as const;
const ARTIFACT_RULES = [
  { type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] },
  {
    type: "pptx",
    extensions: ["pptx"],
    mime_types: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  },
  {
    type: "docx",
    extensions: ["docx"],
    mime_types: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  },
  {
    type: "xlsx",
    extensions: ["xlsx"],
    mime_types: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  },
  {
    type: "image",
    extensions: ["png", "jpg", "jpeg", "gif", "webp"],
    mime_types: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  },
  { type: "html", extensions: ["html", "htm"], mime_types: ["text/html"] },
  { type: "md", extensions: ["md", "markdown"], mime_types: ["text/markdown", "text/plain"] },
  {
    type: "text",
    extensions: ["txt", "log", "json", "csv"],
    mime_types: ["text/plain", "application/json", "text/csv"],
  },
] as const;

const SCHEMA_VERSION = 1;

interface ShareArtifactEntry {
  descriptor: Record<string, unknown>;
  artifact_id: string;
  sha256: string;
  size_bytes: number;
}

interface PreparationRecord {
  title: string;
  accessMode: string;
  payloadSha256: string;
  artifactCount: number;
  artifacts: ShareArtifactEntry[];
  totalArtifactBytes: number;
  expiresAt: number;
}

interface ShareRecord {
  shareId: string;
  title: string;
  accessMode: string;
  rows: readonly unknown[];
  artifacts: ShareArtifactEntry[];
  integrity: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  /** private 分享的访问口令哈希（2026-09-28）：缺失表示历史记录、不校验口令。 */
  pwdHash?: string;
}

export interface MikikoCloudShareEnv {
  MIKIKO_SHARE: KVNamespace;
  MIKIKO_CLIENT_CONFIG: KVNamespace;
  SHARE_ARTIFACTS: R2Bucket;
}

interface ShareRequestContext {
  readonly request: Request;
  readonly env: MikikoCloudShareEnv;
  readonly url: URL;
  readonly origin: string;
}

export async function handleShareRequest(context: ShareRequestContext): Promise<Response> {
  const path = context.url.pathname;
  const method = context.request.method;

  if (path === "/api/v1/shares/device/register") {
    if (method !== "POST") return shareError(405, 3204, "method_not_allowed");
    // 公开无鉴权写端点必须限流（review S1）：防 KV 写配额被打爆与设备表无界增长。
    if (!(await consumeRateLimit(context, "rlreg", DEFAULT_REGISTER_RATE_LIMIT_PER_MINUTE))) {
      return shareError(429, 3002, "rate_limited");
    }
    return registerDevice(context);
  }
  if (path === "/api/v1/shares/capabilities") {
    if (method !== "GET") return shareError(405, 3204, "method_not_allowed");
    if (!(await requireDeviceToken(context))) {
      return shareError(401, 3201, "authentication_required");
    }
    return capabilities(context);
  }
  if (path === "/api/v1/shares/preparations") {
    if (method !== "POST") return shareError(405, 3204, "method_not_allowed");
    if (!(await requireDeviceToken(context))) {
      return shareError(401, 3201, "authentication_required");
    }
    // 限流只计「发布次数」（spec §4.3：1 分钟最多 N 次分享发布）；upload/confirm 是
    // 同一次发布的组成部分，只做设备鉴权，不重复计数——否则带附件的发布会自我饿死。
    if (!(await consumeRateLimit(context))) return shareError(429, 3002, "rate_limited");
    return createPreparation(context);
  }
  const preparationMatch = /^\/api\/v1\/shares\/preparations\/([^/]+)(\/artifacts|\/confirm)$/.exec(
    path,
  );
  if (preparationMatch) {
    if (!(await requireDeviceToken(context))) {
      return shareError(401, 3201, "authentication_required");
    }
    // 与 preparations 的发布计数分开的宽限流（review S2）：upload/confirm 不吃发布配额，
    // 但也不能无限制——设备 token 免费可得，防 R2/KV 滥用面。
    if (!(await consumeRateLimit(context, "rlpub", DEFAULT_PUBLISH_STEP_RATE_LIMIT_PER_MINUTE))) {
      return shareError(429, 3002, "rate_limited");
    }
    if (preparationMatch[2] === "/artifacts") {
      if (method !== "POST") return shareError(405, 3204, "method_not_allowed");
      return uploadArtifact(context, decodeURIComponent(preparationMatch[1]!));
    }
    if (method !== "POST") return shareError(405, 3204, "method_not_allowed");
    return confirmPreparation(context, decodeURIComponent(preparationMatch[1]!));
  }
  const shareMatch =
    /^\/api\/v1\/shares\/([^/]+)(?:\/(preview|continuation|artifacts\/[^/]+))?$/.exec(path);
  if (shareMatch) {
    const shareCode = decodeURIComponent(shareMatch[1]!);
    const tail = shareMatch[2];
    if (tail === "preview") {
      if (method !== "GET") return shareError(405, 3204, "method_not_allowed");
      return previewShare(context, shareCode);
    }
    if (tail === "continuation") {
      if (method !== "POST") return shareError(405, 3204, "method_not_allowed");
      return continueShare(context, shareCode);
    }
    if (tail?.startsWith("artifacts/")) {
      if (method !== "GET") return shareError(405, 3204, "method_not_allowed");
      return downloadShareArtifact(
        context,
        shareCode,
        decodeURIComponent(tail.slice("artifacts/".length)),
      );
    }
    if (!tail) return shareError(404, 3211, "not_found");
  }
  return shareError(404, 3211, "not_found");
}

function shareError(status: number, code: number, msg: string): Response {
  return new Response(JSON.stringify({ code, msg }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function shareData(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, msg: "", data }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function sha256Hex(value: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

function randomToken(bytes: number): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return [...raw].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomSharePwd(): string {
  const raw = new Uint8Array(SHARE_PWD_LENGTH);
  crypto.getRandomValues(raw);
  return [...raw].map((byte) => SHARE_PWD_ALPHABET[byte % SHARE_PWD_ALPHABET.length]!).join("");
}

function randomShareCode(): string {
  const raw = new Uint8Array(SHARE_CODE_LENGTH);
  crypto.getRandomValues(raw);
  return [...raw].map((byte) => SHARE_CODE_ALPHABET[byte % SHARE_CODE_ALPHABET.length]!).join("");
}

/** POST /api/v1/shares/device/register：deviceId 为客户端侧 sha256(deviceMid)。 */
async function registerDevice(context: ShareRequestContext): Promise<Response> {
  let body: { deviceId?: unknown };
  try {
    body = (await context.request.json()) as { deviceId?: unknown };
  } catch {
    return shareError(400, 3203, "invalid_body");
  }
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim().toLowerCase() : "";
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return shareError(400, 3203, "invalid_device_id");
  }
  // token = `${deviceIdHash}.${secret}`：验证时可直接从 token 解析出设备 key 单点查询，
  // 无需遍历设备表；secret 只以哈希落盘。
  const deviceKey = `device:${await sha256Hex(deviceId)}`;
  const secret = randomToken(32);
  const existing = (await context.env.MIKIKO_SHARE.get(deviceKey, "json")) as {
    secretHashes?: string[];
    createdAt?: number;
    registerCount?: number;
  } | null;
  // 多 secret 并存（2026-09-28 修复 401 互踢）：同一设备（同一 deviceMid）的多个进程
  // 各自注册的 token 同时有效——覆盖式单 secret 会让后注册的进程顶掉先注册进程的
  // token（发布脚本/双进程竞态都会触发），客户端旧 token 立即失效且无自愈路径。
  // 上限 DEVICE_SECRET_LIMIT，新 secret 前插、超限淘汰最旧的。
  const secretHashes = [
    await sha256Hex(secret),
    ...(Array.isArray(existing?.secretHashes) ? existing!.secretHashes : []),
  ].slice(0, DEVICE_SECRET_LIMIT);
  // 设备表带 TTL 并在每次注册时续期（review S1）：活跃设备常驻、失活设备自动回收。
  await context.env.MIKIKO_SHARE.put(
    deviceKey,
    JSON.stringify({
      secretHashes,
      createdAt: existing?.createdAt ?? Date.now(),
      registerCount: (existing?.registerCount ?? 0) + 1,
    }),
    { expirationTtl: DEVICE_RECORD_TTL_SECONDS },
  );
  return shareData({ device_token: `${deviceKey.slice("device:".length)}.${secret}` });
}

async function requireDeviceToken(context: ShareRequestContext): Promise<boolean> {
  const header = context.request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const separator = token.indexOf(".");
  if (separator === -1) return false;
  const deviceHash = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!/^[0-9a-f]{64}$/u.test(deviceHash) || !secret) return false;
  const record = (await context.env.MIKIKO_SHARE.get(`device:${deviceHash}`, "json")) as {
    secretHashes?: string[];
    secretHash?: string;
  } | null;
  if (record == null) return false;
  // 兼容多 secret 并存与历史单 secret 记录两种形状。
  const candidates = Array.isArray(record.secretHashes)
    ? record.secretHashes
    : record.secretHash != null
      ? [record.secretHash]
      : [];
  if (candidates.length === 0) return false;
  const secretHash = await sha256Hex(secret);
  return candidates.includes(secretHash);
}

/**
 * IP 限流：KV 分钟桶计数（最终一致，粗粒度足够——防的是批量脚本不是精确配额）。
 * 阈值从 MIKIKO_CLIENT_CONFIG 的 share.publishPerMinutePerIp 读取，与 §4.1 下发值同源。
 */
async function consumeRateLimit(
  context: ShareRequestContext,
  bucketPrefix = "rl",
  fallbackLimit = DEFAULT_SHARE_RATE_LIMIT_PER_MINUTE,
): Promise<boolean> {
  // 只信 Cloudflare 注入的连接 IP（review S2）：x-forwarded-for 可由客户端伪造，
  // 缺失时统一并入 unknown 桶——宁可误伤共享出口，不可被伪造头绕过。
  const ip = context.request.headers.get("cf-connecting-ip") ?? "unknown";
  let limit = fallbackLimit;
  try {
    const configs = (await context.env.MIKIKO_CLIENT_CONFIG.get("client-configs", "json")) as {
      share?: { publishPerMinutePerIp?: unknown };
    } | null;
    const configured = configs?.share?.publishPerMinutePerIp;
    if (
      typeof configured === "number" &&
      Number.isInteger(configured) &&
      configured >= 1 &&
      configured <= 60
    ) {
      limit = configured;
    }
  } catch {
    // 配置面读取失败按默认限流执行，不能放开为无限制。
  }
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `${bucketPrefix}:${ip}:${bucket}`;
  const current = Number.parseInt((await context.env.MIKIKO_SHARE.get(key)) ?? "0", 10) || 0;
  if (current >= limit) return false;
  await context.env.MIKIKO_SHARE.put(key, String(current + 1), { expirationTtl: 120 });
  return true;
}

function capabilities(_context: ShareRequestContext): Response {
  return shareData({
    schema_version: SCHEMA_VERSION,
    ttl_ms: SHARE_TTL_MS,
    max_rows: MAX_ROWS,
    max_payload_bytes: MAX_PAYLOAD_BYTES,
    max_artifact_count: MAX_ARTIFACT_COUNT,
    max_artifact_bytes: MAX_ARTIFACT_BYTES,
    max_total_artifact_bytes: MAX_TOTAL_ARTIFACT_BYTES,
    access_modes: [...ACCESS_MODES],
    allowed_artifacts: ARTIFACT_RULES.map((rule) => ({
      type: rule.type,
      extensions: [...rule.extensions],
      mime_types: [...rule.mime_types],
    })),
  });
}

async function createPreparation(context: ShareRequestContext): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await context.request.json()) as Record<string, unknown>;
  } catch {
    return shareError(400, 3203, "invalid_body");
  }
  if (body.schema_version !== SCHEMA_VERSION)
    return shareError(400, 3203, "unsupported_schema_version");
  const accessMode = body.access_mode;
  if (typeof accessMode !== "string" || !(ACCESS_MODES as readonly string[]).includes(accessMode)) {
    return shareError(400, 3203, "invalid_access_mode");
  }
  const title = body.title;
  if (typeof title !== "string" || !title.trim()) return shareError(400, 3203, "invalid_title");
  const payloadSha256 = body.payload_sha256;
  if (typeof payloadSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(payloadSha256)) {
    return shareError(400, 3203, "invalid_payload_sha256");
  }
  const artifactCount = body.artifact_count;
  if (
    typeof artifactCount !== "number" ||
    !Number.isInteger(artifactCount) ||
    artifactCount < 0 ||
    artifactCount > MAX_ARTIFACT_COUNT
  ) {
    return shareError(400, 3203, "invalid_artifact_count");
  }
  if (typeof body.client_request_id !== "string" || !body.client_request_id.trim()) {
    return shareError(400, 3203, "invalid_client_request_id");
  }
  const preparationId = randomToken(16);
  const record: PreparationRecord = {
    title: title.trim().slice(0, 200),
    accessMode,
    payloadSha256,
    artifactCount,
    artifacts: [],
    totalArtifactBytes: 0,
    expiresAt: Date.now() + PREPARATION_TTL_MS,
  };
  await context.env.MIKIKO_SHARE.put(`prep:${preparationId}`, JSON.stringify(record), {
    expirationTtl: PREPARATION_TTL_MS / 1000,
  });
  return shareData({
    preparation_id: preparationId,
    access_mode: accessMode,
    expires_at: record.expiresAt,
    status: "preparing",
  });
}

async function readPreparation(
  context: ShareRequestContext,
  preparationId: string,
): Promise<PreparationRecord | null> {
  const record = (await context.env.MIKIKO_SHARE.get(
    `prep:${preparationId}`,
    "json",
  )) as PreparationRecord | null;
  if (record == null) return null;
  if (record.expiresAt < Date.now()) return null;
  return record;
}

async function uploadArtifact(
  context: ShareRequestContext,
  preparationId: string,
): Promise<Response> {
  const record = await readPreparation(context, preparationId);
  if (!record) return shareError(404, 3211, "preparation_not_found");

  const contentType = context.request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return shareError(400, 3203, "multipart_required");
  }
  const form = await context.request.formData();
  const descriptorRaw = form.get("descriptor");
  const file = form.get("file");
  // workers-types 环境无 DOM lib，instanceof File 的类型收窄不可靠，改用结构判断。
  if (
    typeof descriptorRaw !== "string" ||
    typeof file !== "object" ||
    file === null ||
    !("arrayBuffer" in file) ||
    !("size" in file)
  ) {
    return shareError(400, 3203, "invalid_multipart_fields");
  }
  const upload = file as File & { size: number };
  let descriptor: Record<string, unknown>;
  try {
    descriptor = JSON.parse(descriptorRaw) as Record<string, unknown>;
  } catch {
    return shareError(400, 3203, "invalid_descriptor");
  }
  // descriptor 白名单校验（review S10）：恶意发布者可存入缺字段的 descriptor，
  // 让读者端 preview/continuation 直接 invalid_contract（"读者打不开"的分享）。
  const descriptorCheck = validateArtifactDescriptorShape(descriptor);
  if (descriptorCheck !== null) return shareError(400, 3203, descriptorCheck);
  const artifactType = descriptor.artifact_type;
  const rule =
    typeof artifactType === "string"
      ? ARTIFACT_RULES.find((entry) => entry.type === artifactType)
      : undefined;
  if (!rule) return shareError(400, 3208, "artifact_not_allowed");
  const extension = descriptor.extension;
  if (
    typeof extension !== "string" ||
    !(rule.extensions as readonly string[]).includes(extension)
  ) {
    return shareError(400, 3208, "artifact_extension_not_allowed");
  }
  const mimeType = descriptor.mime_type;
  if (typeof mimeType !== "string" || !(rule.mime_types as readonly string[]).includes(mimeType)) {
    return shareError(400, 3208, "artifact_mime_not_allowed");
  }
  const artifactId = descriptor.artifact_id;
  if (typeof artifactId !== "string" || !artifactId.trim()) {
    return shareError(400, 3203, "invalid_artifact_id");
  }
  if (record.artifacts.some((entry) => entry.artifact_id === artifactId)) {
    return shareError(409, 3209, "duplicate_artifact");
  }
  if (upload.size > MAX_ARTIFACT_BYTES) return shareError(413, 3209, "artifact_too_large");
  if (record.totalArtifactBytes + upload.size > MAX_TOTAL_ARTIFACT_BYTES) {
    return shareError(413, 3209, "total_artifact_bytes_exceeded");
  }
  const expectedSha = descriptor.sha256;
  if (typeof expectedSha !== "string" || !/^[0-9a-f]{64}$/u.test(expectedSha)) {
    return shareError(400, 3203, "invalid_artifact_sha256");
  }
  const buffer = await upload.arrayBuffer();
  const actualSha = await crypto.subtle
    .digest("SHA-256", buffer)
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  if (actualSha !== expectedSha) return shareError(400, 3210, "sha256_mismatch");

  await context.env.SHARE_ARTIFACTS.put(`artifacts/${expectedSha}`, buffer, {
    httpMetadata: { contentType: mimeType },
  });
  record.artifacts.push({
    descriptor,
    artifact_id: artifactId,
    sha256: expectedSha,
    size_bytes: upload.size,
  });
  record.totalArtifactBytes += upload.size;
  await context.env.MIKIKO_SHARE.put(`prep:${preparationId}`, JSON.stringify(record), {
    expirationTtl: Math.max(60, Math.floor((record.expiresAt - Date.now()) / 1000)),
  });
  return shareData({
    artifact_id: artifactId,
    size_bytes: upload.size,
    sha256: expectedSha,
    status: "uploaded",
    safety_status: "clean",
  });
}

async function confirmPreparation(
  context: ShareRequestContext,
  preparationId: string,
): Promise<Response> {
  const record = await readPreparation(context, preparationId);
  if (!record) return shareError(404, 3211, "preparation_not_found");

  let body: Record<string, unknown>;
  try {
    body = (await context.request.json()) as Record<string, unknown>;
  } catch {
    return shareError(400, 3203, "invalid_body");
  }
  const projection = body.projection as { rows?: unknown } | undefined;
  const rows = Array.isArray(projection?.rows) ? projection!.rows : null;
  if (!rows || rows.length === 0) return shareError(400, 3205, "invalid_conversation");
  if (rows.length > MAX_ROWS) return shareError(413, 3209, "rows_exceeded");
  const payloadBytes = JSON.stringify(rows).length;
  if (payloadBytes > MAX_PAYLOAD_BYTES) return shareError(413, 3209, "payload_too_large");
  const disclosure = body.disclosure_confirmation as
    | { acknowledged_no_secret_detection?: unknown }
    | undefined;
  if (disclosure?.acknowledged_no_secret_detection !== true) {
    return shareError(400, 3206, "disclosure_required");
  }
  const integrity = body.integrity;
  if (typeof integrity !== "object" || integrity === null) {
    return shareError(400, 3203, "invalid_integrity");
  }
  const integrityRecord = integrity as Record<string, unknown>;
  for (const field of ["projection_sha256", "artifact_set_sha256"]) {
    const value = integrityRecord[field];
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
      return shareError(400, 3203, `invalid_${field}`);
    }
  }
  // preparation 的 payload_sha256 是客户端对「整个 confirm 请求」的规范哈希声明
  // （conversationShareService.ts:2063），与 integrity.projection_sha256（仅 rows 投影）
  // 不是同一算法目标，服务端不得强制比对——此前误加的一致性校验会把全部发布
  // 误判为 payload_sha256_mismatch 拒绝（2026-09-28 线上报障根因）。声明值仅存档。
  if (record.artifactCount !== record.artifacts.length) {
    return shareError(400, 3210, "upload_incomplete");
  }

  const shareCode = randomShareCode();
  const now = Date.now();
  const isPrivate = record.accessMode === "private";
  // private 分享自动生成访问口令（2026-09-28）：拼进 share_url 随链接分发——
  // 链接即口令（拿到完整链接的人可直接打开），链接丢失 query 时须手动输入；
  // 服务端只落哈希。客户端发布链路零改动（share_url 由本服务端构造）。
  const sharePwd = isPrivate ? randomSharePwd() : undefined;
  const share: ShareRecord = {
    shareId: randomToken(16),
    title: record.title,
    accessMode: record.accessMode,
    rows,
    artifacts: record.artifacts,
    integrity: integrity as Record<string, unknown>,
    createdAt: now,
    expiresAt: now + SHARE_TTL_MS,
    ...(sharePwd !== undefined ? { pwdHash: await sha256Hex(sharePwd) } : {}),
  };
  await context.env.MIKIKO_SHARE.put(`share:${shareCode}`, JSON.stringify(share), {
    expirationTtl: SHARE_TTL_MS / 1000,
  });
  await context.env.MIKIKO_SHARE.delete(`prep:${preparationId}`);
  return shareData({
    share_code: shareCode,
    share_url:
      `${context.origin}/cn/share/${shareCode}` +
      (sharePwd !== undefined ? `?pwd=${sharePwd}` : ""),
    access_mode: record.accessMode,
    expires_at: share.expiresAt,
  });
}

/**
 * private 分享口令门（2026-09-28）：仅当记录带 pwdHash 时启用——历史 private 记录
 * 不受影响。口令缺失与口令错误用不同 msg，落地页据此区分「提示输入」与「提示错误」。
 * 通过返回 null（放行），否则返回 403 响应。
 */
async function assertSharePassword(
  context: ShareRequestContext,
  share: ShareRecord,
): Promise<Response | null> {
  if (share.pwdHash === undefined) return null;
  const provided = context.url.searchParams.get("pwd")?.trim() ?? "";
  if (!provided) return shareError(403, 3201, "password_required");
  if ((await sha256Hex(provided)) !== share.pwdHash) {
    return shareError(403, 3201, "password_mismatch");
  }
  return null;
}

async function readShare(
  context: ShareRequestContext,
  shareCode: string,
): Promise<ShareRecord | null> {
  if (!/^[a-z0-9]{4,32}$/u.test(shareCode)) return null;
  const share = (await context.env.MIKIKO_SHARE.get(
    `share:${shareCode}`,
    "json",
  )) as ShareRecord | null;
  if (share == null) return null;
  if (share.expiresAt < Date.now()) return null;
  return share;
}

function artifactEntriesForResponse(
  context: ShareRequestContext,
  shareCode: string,
  share: ShareRecord,
  urlField: "url" | "download_url",
  expiresAt: number,
): Array<Record<string, unknown>> {
  return share.artifacts.map((entry) => ({
    ...entry.descriptor,
    [urlField]: `${context.origin}/api/v1/shares/${encodeURIComponent(shareCode)}/artifacts/${encodeURIComponent(entry.artifact_id)}`,
    [`${urlField}_expires_at`]: expiresAt,
  }));
}

async function previewShare(context: ShareRequestContext, shareCode: string): Promise<Response> {
  const share = await readShare(context, shareCode);
  if (!share) return shareError(404, 3212, "share_not_found_or_expired");
  const gate = await assertSharePassword(context, share);
  if (gate !== null) return gate;
  const urlExpiresAt = Date.now() + SHARE_TTL_MS;
  return shareData({
    schema_version: SCHEMA_VERSION,
    share: {
      title: share.title,
      access_mode: share.accessMode,
      created_at: share.createdAt,
      expires_at: share.expiresAt,
    },
    rows: share.rows,
    artifacts: artifactEntriesForResponse(context, shareCode, share, "url", urlExpiresAt),
    integrity: share.integrity,
  });
}

async function continueShare(context: ShareRequestContext, shareCode: string): Promise<Response> {
  const share = await readShare(context, shareCode);
  if (!share) return shareError(404, 3212, "share_not_found_or_expired");
  const gate = await assertSharePassword(context, share);
  if (gate !== null) return gate;
  if (share.accessMode !== "public_importable") {
    return shareError(403, 3214, "import_not_allowed");
  }
  let body: Record<string, unknown>;
  try {
    body = (await context.request.json()) as Record<string, unknown>;
  } catch {
    return shareError(400, 3203, "invalid_body");
  }
  if (body.schema_version !== SCHEMA_VERSION)
    return shareError(400, 3203, "unsupported_schema_version");
  const urlExpiresAt = Date.now() + IMPORT_GRANT_TTL_MS;
  return shareData({
    schema_version: SCHEMA_VERSION,
    import_grant_id: randomToken(16),
    import_grant_expires_at: Date.now() + IMPORT_GRANT_TTL_MS,
    share: {
      share_id: share.shareId,
      title: share.title,
      access_mode: share.accessMode,
      created_at: share.createdAt,
      expires_at: share.expiresAt,
    },
    rows: share.rows,
    artifacts: artifactEntriesForResponse(context, shareCode, share, "download_url", urlExpiresAt),
    integrity: share.integrity,
  });
}

async function downloadShareArtifact(
  context: ShareRequestContext,
  shareCode: string,
  artifactId: string,
): Promise<Response> {
  const share = await readShare(context, shareCode);
  if (!share) return shareError(404, 3212, "share_not_found_or_expired");
  const entry = share.artifacts.find((item) => item.artifact_id === artifactId);
  if (!entry) return shareError(404, 3211, "artifact_not_found");
  const object = await context.env.SHARE_ARTIFACTS.get(`artifacts/${entry.sha256}`);
  if (object == null) return shareError(404, 3211, "artifact_object_missing");
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "public, max-age=3600",
    },
  });
}

/** descriptor 必填字段白名单（与客户端入站 schema 对齐，review S10）。 */
function validateArtifactDescriptorShape(descriptor: Record<string, unknown>): string | null {
  const hex64 = (value: unknown): boolean =>
    typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
  if (typeof descriptor.artifact_id !== "string" || !descriptor.artifact_id.trim()) {
    return "descriptor_missing_artifact_id";
  }
  if (
    typeof descriptor.logical_artifact_key !== "string" ||
    !descriptor.logical_artifact_key.trim()
  ) {
    return "descriptor_missing_logical_artifact_key";
  }
  if (
    typeof descriptor.producer_product_turn_id !== "string" ||
    !descriptor.producer_product_turn_id.trim()
  ) {
    return "descriptor_missing_producer_product_turn_id";
  }
  if (
    descriptor.artifact_version !== undefined &&
    (typeof descriptor.artifact_version !== "number" ||
      !Number.isInteger(descriptor.artifact_version) ||
      descriptor.artifact_version < 1)
  ) {
    return "descriptor_invalid_artifact_version";
  }
  if (descriptor.state !== undefined && descriptor.state !== "current") {
    return "descriptor_invalid_state";
  }
  if (
    typeof descriptor.ref !== "string" ||
    !/^zcode-artifact:\/\/share\/[A-Za-z0-9._~-]+$/u.test(descriptor.ref)
  ) {
    return "descriptor_invalid_ref";
  }
  if (typeof descriptor.display_name !== "string" || !descriptor.display_name.trim()) {
    return "descriptor_missing_display_name";
  }
  if (!hex64(descriptor.sha256)) return "descriptor_invalid_sha256";
  if (
    typeof descriptor.size_bytes !== "number" ||
    !Number.isInteger(descriptor.size_bytes) ||
    descriptor.size_bytes < 0
  ) {
    return "descriptor_invalid_size_bytes";
  }
  return null;
}
