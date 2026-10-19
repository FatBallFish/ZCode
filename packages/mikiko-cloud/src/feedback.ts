/* eslint-disable max-lines -- 反馈工单单模块承载客户端/管理两端点族与 D1 行映射；拆分需跨模块共享行类型与枚举，先例见 worker.ts/shares.ts。 */
import {
  consumeKvMinuteRateLimit,
  verifyMikikoDeviceToken,
} from "./shares.js";

/**
 * Bug 问题上报 + 工单管理（specs/mikiko-cloud/feedback-tickets.md）。
 *
 * 客户端端点（设备 token 鉴权，与 shares 共用 /api/v1/shares/device/register 注册）：
 *   POST /api/v1/feedback/tickets                          创建工单（默认 pending_triage）
 *   POST /api/v1/feedback/tickets/{id}/attachments          附件二进制中转上传（R2）
 * 管理端点（admin session cookie，worker.ts 统一门禁后转入）：
 *   GET    /api/v1/admin/feedback/tickets?status&type&q&page&pageSize
 *   GET    /api/v1/admin/feedback/tickets/{id}              详情（工单+评论+附件）
 *   PATCH  /api/v1/admin/feedback/tickets/{id}              状态/类型/修复版本/跟进人
 *   GET    /api/v1/admin/feedback/tickets/{id}/attachments/{aid}   R2 附件下载
 *   POST   /api/v1/admin/feedback/tickets/{id}/comments     追加评论
 *   PATCH  /api/v1/admin/feedback/tickets/{id}/comments/{cid}
 *   DELETE /api/v1/admin/feedback/tickets/{id}/comments/{cid}
 *
 * 存储：D1（工单/评论/附件元数据）+ R2（附件内容，feedback/ 前缀）。
 * 状态与类型存机器码，枚举在本模块封闭定义（UI 中文文案在 admin 页）。
 */

export interface MikikoCloudFeedbackEnv {
  DB: D1Database;
  MIKIKO_SHARE: KVNamespace;
  FEEDBACK_ARTIFACTS: R2Bucket;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

/** 工单状态（机器码 ↔ admin UI 中文文案的映射在 admin.html 维护）。 */
export const FEEDBACK_TICKET_STATUSES = [
  "pending_triage",
  "triaging",
  "located",
  "not_issue",
  "awaiting_release",
  "resolved",
] as const;
export type FeedbackTicketStatus = (typeof FEEDBACK_TICKET_STATUSES)[number];

/** 工单类型（上报时为空，由跟进人在后台归类）。 */
export const FEEDBACK_TICKET_TYPES = [
  "legacy_bug",
  "new_regression",
  "config_issue",
  "product_misunderstanding",
  "env_data_anomaly",
  "product_design",
  "other",
] as const;
export type FeedbackTicketType = (typeof FEEDBACK_TICKET_TYPES)[number];

const CREATE_RATE_LIMIT_PER_MINUTE = 5;
const ATTACHMENT_RATE_LIMIT_PER_MINUTE = 20;
const MAX_ATTACHMENTS_PER_TICKET = 6;
const MAX_LOG_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MAX_SCREENSHOT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 8000;
const MAX_CONTACT_LENGTH = 200;
const MAX_ENVIRONMENT_JSON_BYTES = 16 * 1024;
const ATTACHMENT_CONTENT_TYPES = new Set([
  "application/zip",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function feedbackData(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, msg: "", data }), {
    status,
    headers: JSON_HEADERS,
  });
}

function feedbackError(status: number, code: number, msg: string): Response {
  return new Response(JSON.stringify({ code, msg }), { status, headers: JSON_HEADERS });
}

function randomId(prefix: string): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  return `${prefix}_${[...raw].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function readString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > max ? undefined : trimmed;
}

interface TicketRow {
  id: string;
  client_ticket_id: string | null;
  device_hash: string;
  title: string;
  description: string;
  contact: string | null;
  environment_json: string;
  app_version: string | null;
  platform: string | null;
  locale: string | null;
  status: string;
  type: string | null;
  fix_version: string | null;
  assignee: string | null;
  attachment_count: number;
  created_at: number;
  updated_at: number;
}

interface CommentRow {
  id: string;
  ticket_id: string;
  author: string;
  body: string;
  created_at: number;
  updated_at: number;
}

interface AttachmentRow {
  id: string;
  ticket_id: string;
  kind: string;
  file_name: string;
  content_type: string;
  size: number;
  r2_key: string;
  created_at: number;
}

function serializeTicket(row: TicketRow) {
  return {
    id: row.id,
    clientTicketId: row.client_ticket_id,
    title: row.title,
    description: row.description,
    contact: row.contact,
    environment: JSON.parse(row.environment_json) as unknown,
    appVersion: row.app_version,
    platform: row.platform,
    locale: row.locale,
    status: row.status,
    type: row.type,
    fixVersion: row.fix_version,
    assignee: row.assignee,
    attachmentCount: row.attachment_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeComment(row: CommentRow) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeAttachment(row: AttachmentRow) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    kind: row.kind,
    fileName: row.file_name,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

// ── 客户端端点 ──

export async function handleFeedbackRequest(
  request: Request,
  env: MikikoCloudFeedbackEnv,
  pathname: string,
): Promise<Response> {
  if (!(await verifyMikikoDeviceToken(request, env.MIKIKO_SHARE))) {
    return feedbackError(401, 3401, "authentication_required");
  }
  if (pathname === "/api/v1/feedback/tickets") {
    if (request.method !== "POST") return feedbackError(405, 3405, "method_not_allowed");
    if (!(await consumeKvMinuteRateLimit(env.MIKIKO_SHARE, request, "fb-rl-create", CREATE_RATE_LIMIT_PER_MINUTE))) {
      return feedbackError(429, 3402, "rate_limited");
    }
    return createFeedbackTicket(request, env);
  }
  const attachmentMatch = /^\/api\/v1\/feedback\/tickets\/([^/]+)\/attachments$/.exec(pathname);
  if (attachmentMatch) {
    if (request.method !== "POST") return feedbackError(405, 3405, "method_not_allowed");
    if (!(await consumeKvMinuteRateLimit(env.MIKIKO_SHARE, request, "fb-rl-attach", ATTACHMENT_RATE_LIMIT_PER_MINUTE))) {
      return feedbackError(429, 3402, "rate_limited");
    }
    return uploadFeedbackAttachment(request, env, decodeURIComponent(attachmentMatch[1]!));
  }
  return feedbackError(404, 3404, "not_found");
}

async function createFeedbackTicket(
  request: Request,
  env: MikikoCloudFeedbackEnv,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return feedbackError(400, 3403, "invalid_body");
  }
  const title = readString(body.title, MAX_TITLE_LENGTH);
  const description = readString(body.description, MAX_DESCRIPTION_LENGTH);
  if (title === undefined || description === undefined) {
    return feedbackError(400, 3403, "invalid_title_or_description");
  }
  const contact = readString(body.contact, MAX_CONTACT_LENGTH) ?? null;
  const clientTicketId = readString(body.clientTicketId, 128) ?? null;
  const environment =
    body.environment !== undefined && typeof body.environment === "object" && body.environment !== null
      ? body.environment
      : {};
  const environmentJson = JSON.stringify(environment);
  if (environmentJson.length > MAX_ENVIRONMENT_JSON_BYTES) {
    return feedbackError(400, 3403, "environment_too_large");
  }

  // 工单归属设备：从 token 解出 deviceHash（64 hex），无需信任 body 自报身份。
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/u, "");
  const deviceHash = token.split(".")[0] ?? "";
  if (!/^[0-9a-f]{64}$/u.test(deviceHash)) {
    return feedbackError(401, 3401, "authentication_required");
  }

  const now = Date.now();
  const id = randomId("fb");
  await env.DB.prepare(
    `INSERT INTO feedback_tickets
       (id, client_ticket_id, device_hash, title, description, contact, environment_json,
        app_version, platform, locale, status, type, fix_version, assignee,
        attachment_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending_triage', NULL, NULL, NULL, 0, ?11, ?11)`,
  )
    .bind(
      id,
      clientTicketId,
      deviceHash,
      title,
      description,
      contact,
      environmentJson,
      readString(body.appVersion, 64) ?? null,
      readString(body.platform, 64) ?? null,
      readString(body.locale, 32) ?? null,
      now,
    )
    .run();
  return feedbackData({ ticketId: id, status: "pending_triage" }, 201);
}

async function uploadFeedbackAttachment(
  request: Request,
  env: MikikoCloudFeedbackEnv,
  ticketId: string,
): Promise<Response> {
  const ticket = await env.DB.prepare("SELECT id FROM feedback_tickets WHERE id = ?1")
    .bind(ticketId)
    .first<{ id: string }>();
  if (ticket === null) return feedbackError(404, 3404, "ticket_not_found");

  const kind = request.headers.get("x-attachment-kind") === "screenshot" ? "screenshot" : "log";
  const fileName =
    readString(request.headers.get("x-file-name") ?? "", 190) ?? `${kind}-${Date.now()}`;
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const declaredSize = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  const maxBytes = kind === "log" ? MAX_LOG_ATTACHMENT_BYTES : MAX_SCREENSHOT_ATTACHMENT_BYTES;
  if (!ATTACHMENT_CONTENT_TYPES.has(contentType)) {
    return feedbackError(400, 3403, "unsupported_content_type");
  }
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    return feedbackError(413, 3406, "attachment_too_large");
  }

  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM feedback_attachments WHERE ticket_id = ?1",
  )
    .bind(ticketId)
    .first<{ count: number }>();
  if ((countRow?.count ?? 0) >= MAX_ATTACHMENTS_PER_TICKET) {
    return feedbackError(400, 3407, "too_many_attachments");
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength === 0) return feedbackError(400, 3403, "empty_attachment");
  if (buffer.byteLength > maxBytes) return feedbackError(413, 3406, "attachment_too_large");

  const now = Date.now();
  const attachmentId = randomId("fa");
  const r2Key = `feedback/${ticketId}/${attachmentId}`;
  await env.FEEDBACK_ARTIFACTS.put(r2Key, buffer, {
    httpMetadata: { contentType },
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO feedback_attachments
         (id, ticket_id, kind, file_name, content_type, size, r2_key, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(attachmentId, ticketId, kind, fileName, contentType, buffer.byteLength, r2Key, now),
    env.DB.prepare(
      "UPDATE feedback_tickets SET attachment_count = attachment_count + 1, updated_at = ?2 WHERE id = ?1",
    ).bind(ticketId, now),
  ]);
  return feedbackData({ attachmentId, size: buffer.byteLength }, 201);
}

// ── 管理端点（worker.ts 的 admin session 门禁之后转入）──

export async function handleAdminFeedbackRequest(
  request: Request,
  env: MikikoCloudFeedbackEnv,
  pathname: string,
): Promise<Response> {
  if (pathname === "/api/v1/admin/feedback/tickets") {
    if (request.method !== "GET") return feedbackError(405, 3405, "method_not_allowed");
    return listFeedbackTickets(request, env);
  }
  let match = /^\/api\/v1\/admin\/feedback\/tickets\/([^/]+)$/.exec(pathname);
  if (match) {
    const ticketId = decodeURIComponent(match[1]!);
    if (request.method === "GET") return getFeedbackTicketDetail(env, ticketId);
    if (request.method === "PATCH") return patchFeedbackTicket(request, env, ticketId);
    return feedbackError(405, 3405, "method_not_allowed");
  }
  match = /^\/api\/v1\/admin\/feedback\/tickets\/([^/]+)\/attachments\/([^/]+)$/.exec(pathname);
  if (match) {
    if (request.method !== "GET") return feedbackError(405, 3405, "method_not_allowed");
    return downloadFeedbackAttachment(
      env,
      decodeURIComponent(match[1]!),
      decodeURIComponent(match[2]!),
    );
  }
  match = /^\/api\/v1\/admin\/feedback\/tickets\/([^/]+)\/comments$/.exec(pathname);
  if (match) {
    if (request.method !== "POST") return feedbackError(405, 3405, "method_not_allowed");
    return createFeedbackComment(request, env, decodeURIComponent(match[1]!));
  }
  match = /^\/api\/v1\/admin\/feedback\/tickets\/([^/]+)\/comments\/([^/]+)$/.exec(pathname);
  if (match) {
    const ticketId = decodeURIComponent(match[1]!);
    const commentId = decodeURIComponent(match[2]!);
    if (request.method === "PATCH") return updateFeedbackComment(request, env, ticketId, commentId);
    if (request.method === "DELETE") return deleteFeedbackComment(env, ticketId, commentId);
    return feedbackError(405, 3405, "method_not_allowed");
  }
  return feedbackError(404, 3404, "not_found");
}

async function listFeedbackTickets(
  request: Request,
  env: MikikoCloudFeedbackEnv,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const pageSize = Math.min(Math.max(Number.parseInt(params.get("pageSize") ?? "20", 10) || 20, 1), 100);
  const page = Math.max(Number.parseInt(params.get("page") ?? "1", 10) || 1, 1);
  const status = params.get("status");
  const type = params.get("type");
  const keyword = params.get("q");

  const where: string[] = [];
  const binds: unknown[] = [];
  if (status !== null && status !== "" && (FEEDBACK_TICKET_STATUSES as readonly string[]).includes(status)) {
    where.push("status = ?");
    binds.push(status);
  }
  if (type !== null && type !== "" && (FEEDBACK_TICKET_TYPES as readonly string[]).includes(type)) {
    where.push("type = ?");
    binds.push(type);
  }
  if (keyword !== null && keyword.trim().length > 0) {
    // SQLite LIKE 转义：反斜杠转义 % _ \，配 ESCAPE 子句；关键词本身不参与 LIKE 通配。
    const escaped = `%${keyword.trim().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    binds.push(escaped, escaped);
  }
  const whereClause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM feedback_tickets${whereClause}`,
  )
    .bind(...binds)
    .first<{ total: number }>();
  const rows = await env.DB.prepare(
    `SELECT * FROM feedback_tickets${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, pageSize, (page - 1) * pageSize)
    .all<TicketRow>();

  return feedbackData({
    items: (rows.results ?? []).map(serializeTicket),
    total: totalRow?.total ?? 0,
    page,
    pageSize,
  });
}

async function loadTicket(env: MikikoCloudFeedbackEnv, ticketId: string): Promise<TicketRow | null> {
  return env.DB.prepare("SELECT * FROM feedback_tickets WHERE id = ?1").bind(ticketId).first<TicketRow>();
}

async function getFeedbackTicketDetail(
  env: MikikoCloudFeedbackEnv,
  ticketId: string,
): Promise<Response> {
  const ticket = await loadTicket(env, ticketId);
  if (ticket === null) return feedbackError(404, 3404, "ticket_not_found");
  const comments = await env.DB.prepare(
    "SELECT * FROM feedback_comments WHERE ticket_id = ?1 ORDER BY created_at ASC",
  )
    .bind(ticketId)
    .all<CommentRow>();
  const attachments = await env.DB.prepare(
    "SELECT * FROM feedback_attachments WHERE ticket_id = ?1 ORDER BY created_at ASC",
  )
    .bind(ticketId)
    .all<AttachmentRow>();
  return feedbackData({
    ticket: serializeTicket(ticket),
    comments: (comments.results ?? []).map(serializeComment),
    attachments: (attachments.results ?? []).map(serializeAttachment),
  });
}

async function patchFeedbackTicket(
  request: Request,
  env: MikikoCloudFeedbackEnv,
  ticketId: string,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return feedbackError(400, 3403, "invalid_body");
  }
  const ticket = await loadTicket(env, ticketId);
  if (ticket === null) return feedbackError(404, 3404, "ticket_not_found");

  const updates: { column: string; value: string | null }[] = [];
  if (body.status !== undefined) {
    if (
      typeof body.status !== "string" ||
      !(FEEDBACK_TICKET_STATUSES as readonly string[]).includes(body.status)
    ) {
      return feedbackError(400, 3403, "invalid_status");
    }
    updates.push({ column: "status", value: body.status });
  }
  if (body.type !== undefined) {
    if (body.type === null || body.type === "") {
      updates.push({ column: "type", value: null });
    } else if (
      typeof body.type === "string" &&
      (FEEDBACK_TICKET_TYPES as readonly string[]).includes(body.type)
    ) {
      updates.push({ column: "type", value: body.type });
    } else {
      return feedbackError(400, 3403, "invalid_type");
    }
  }
  const fixVersion = readString(body.fixVersion ?? "", 64);
  if (body.fixVersion !== undefined) updates.push({ column: "fix_version", value: fixVersion ?? null });
  const assignee = readString(body.assignee ?? "", 64);
  if (body.assignee !== undefined) updates.push({ column: "assignee", value: assignee ?? null });

  if (updates.length === 0) return feedbackError(400, 3403, "no_fields_to_update");

  const setClause = updates.map((update) => `${update.column} = ?`).join(", ");
  const binds: unknown[] = [...updates.map((update) => update.value), Date.now(), ticketId];
  await env.DB.prepare(
    `UPDATE feedback_tickets SET ${setClause}, updated_at = ? WHERE id = ?`,
  )
    .bind(...binds)
    .run();
  const updated = await loadTicket(env, ticketId);
  return feedbackData({ ticket: updated === null ? null : serializeTicket(updated) });
}

async function downloadFeedbackAttachment(
  env: MikikoCloudFeedbackEnv,
  ticketId: string,
  attachmentId: string,
): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT * FROM feedback_attachments WHERE id = ?1 AND ticket_id = ?2",
  )
    .bind(attachmentId, ticketId)
    .first<AttachmentRow>();
  if (row === null) return feedbackError(404, 3404, "attachment_not_found");
  const object = await env.FEEDBACK_ARTIFACTS.get(row.r2_key);
  if (object === null) return feedbackError(404, 3404, "attachment_object_missing");
  const encodedName = encodeURIComponent(row.file_name);
  return new Response(object.body, {
    headers: {
      "content-type": row.content_type,
      "content-length": String(row.size),
      "content-disposition": `attachment; filename*=UTF-8''${encodedName}`,
      "cache-control": "private, max-age=60",
    },
  });
}

async function createFeedbackComment(
  request: Request,
  env: MikikoCloudFeedbackEnv,
  ticketId: string,
): Promise<Response> {
  const ticket = await loadTicket(env, ticketId);
  if (ticket === null) return feedbackError(404, 3404, "ticket_not_found");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return feedbackError(400, 3403, "invalid_body");
  }
  const author = readString(body.author, 64);
  const commentBody = readString(body.body, 8000);
  if (author === undefined || commentBody === undefined) {
    return feedbackError(400, 3403, "invalid_author_or_body");
  }
  const now = Date.now();
  const id = randomId("fc");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO feedback_comments (id, ticket_id, author, body, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    ).bind(id, ticketId, author, commentBody, now),
    env.DB.prepare("UPDATE feedback_tickets SET updated_at = ?2 WHERE id = ?1").bind(ticketId, now),
  ]);
  return feedbackData({ commentId: id }, 201);
}

async function updateFeedbackComment(
  request: Request,
  env: MikikoCloudFeedbackEnv,
  ticketId: string,
  commentId: string,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return feedbackError(400, 3403, "invalid_body");
  }
  const commentBody = readString(body.body, 8000);
  const author = readString(body.author ?? "", 64);
  if (commentBody === undefined) return feedbackError(400, 3403, "invalid_body_value");
  await env.DB.prepare(
    "UPDATE feedback_comments SET body = ?1, author = COALESCE(?2, author), updated_at = ?3 WHERE id = ?4 AND ticket_id = ?5",
  )
    .bind(commentBody, author ?? null, Date.now(), commentId, ticketId)
    .run();
  const updated = await env.DB.prepare(
    "SELECT * FROM feedback_comments WHERE id = ?1 AND ticket_id = ?2",
  )
    .bind(commentId, ticketId)
    .first<CommentRow>();
  if (updated === null) return feedbackError(404, 3404, "comment_not_found");
  return feedbackData({ comment: serializeComment(updated) });
}

async function deleteFeedbackComment(
  env: MikikoCloudFeedbackEnv,
  ticketId: string,
  commentId: string,
): Promise<Response> {
  const result = await env.DB.prepare(
    "DELETE FROM feedback_comments WHERE id = ?1 AND ticket_id = ?2",
  )
    .bind(commentId, ticketId)
    .run();
  if (result.meta.changes === 0) return feedbackError(404, 3404, "comment_not_found");
  return feedbackData({ ok: true });
}
