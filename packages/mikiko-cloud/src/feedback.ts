import { consumeKvMinuteRateLimit, verifyMikikoDeviceToken } from "./shares.js";
import {
  MikikoOidcAuthError,
  requireMikikoOidcIdentity,
  type MikikoOidcIdentity,
} from "./oidcTokenVerify.js";

/**
 * Bug 问题上报 + 工单管理（specs/mikiko-cloud/feedback-tickets.md）。
 *
 * 客户端端点（设备 token 鉴权，与 shares 共用 /api/v1/shares/device/register 注册）：
 *   POST /api/v1/feedback/tickets                          创建工单（默认 pending_triage）
 *   POST /api/v1/feedback/tickets/{id}/attachments          附件二进制中转上传（R2）
 * 账号端点（Mikiko ID Bearer，2026-10-20 批次 3 / docs F.2）：
 *   GET  /api/v1/feedback/tickets/mine                     我的反馈（owner_sub 过滤分页）
 *   GET  /api/v1/feedback/tickets/{id}                     本人工单详情（含评论/附件）
 *   POST /api/v1/feedback/tickets/{id}/comments            本人追加评论
 *   POST /api/v1/feedback/tickets/migrate                  本地历史工单幂等迁移到账号
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

import {
  feedbackData,
  feedbackError,
  randomId,
  readString,
  serializeTicket,
  serializeComment,
  serializeAttachment,
  loadTicket,
  FEEDBACK_TICKET_STATUSES,
  type MikikoCloudFeedbackEnv,
  type TicketRow,
  type CommentRow,
  type AttachmentRow,
} from "./feedbackModel.js";
export { handleAdminFeedbackRequest } from "./feedbackAdmin.js";
export {
  FEEDBACK_TICKET_STATUSES,
  FEEDBACK_TICKET_TYPES,
  type FeedbackTicketStatus,
  type FeedbackTicketType,
  type MikikoCloudFeedbackEnv,
} from "./feedbackModel.js";

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

export async function handleFeedbackRequest(
  request: Request,
  env: MikikoCloudFeedbackEnv,
  pathname: string,
): Promise<Response> {
  // 账号端点（Mikiko ID Bearer）：鉴权失败 fail-close，不降级设备 token。
  const issuer = env.MIKIKO_OIDC_ISSUER?.trim() ?? "";
  if (
    issuer &&
    (pathname === "/api/v1/feedback/tickets/mine" ||
      pathname === "/api/v1/feedback/tickets/migrate" ||
      /^\/api\/v1\/feedback\/tickets\/[^/]+\/?$/.test(pathname) ||
      /^\/api\/v1\/feedback\/tickets\/[^/]+\/comments$/.test(pathname))
  ) {
    try {
      const identity = await requireMikikoOidcIdentity(request, issuer);
      if (pathname === "/api/v1/feedback/tickets/mine") {
        if (request.method !== "GET") return feedbackError(405, 3405, "method_not_allowed");
        return listMyFeedbackTickets(request, env, identity);
      }
      if (pathname === "/api/v1/feedback/tickets/migrate") {
        if (request.method !== "POST") return feedbackError(405, 3405, "method_not_allowed");
        return migrateFeedbackTickets(request, env, identity);
      }
      const detailMatch = /^\/api\/v1\/feedback\/tickets\/([^/]+)\/?$/.exec(pathname);
      if (detailMatch) {
        if (request.method !== "GET") return feedbackError(405, 3405, "method_not_allowed");
        return getOwnFeedbackTicketDetail(env, identity, decodeURIComponent(detailMatch[1]!));
      }
      const commentMatch = /^\/api\/v1\/feedback\/tickets\/([^/]+)\/comments$/.exec(pathname);
      if (commentMatch) {
        if (request.method !== "POST") return feedbackError(405, 3405, "method_not_allowed");
        return createOwnFeedbackComment(
          request,
          env,
          identity,
          decodeURIComponent(commentMatch[1]!),
        );
      }
    } catch (error) {
      if (error instanceof MikikoOidcAuthError) {
        return feedbackError(error.status, 3410, error.code);
      }
      throw error;
    }
  }
  // 创建工单双轨：Mikiko ID Bearer（账户化）或设备 token（匿名）任一通过即可；
  // Bearer 的有效性（fail-close）在 createFeedbackTicket 内校验。
  const bearerAuthorization = request.headers.get("authorization") ?? "";
  const hasBearer = issuer !== "" && /^Bearer\s+/i.test(bearerAuthorization);
  const deviceOk = await verifyMikikoDeviceToken(request, env.MIKIKO_SHARE);
  const isCreatePath = pathname === "/api/v1/feedback/tickets";
  if ((!isCreatePath || !hasBearer) && !deviceOk) {
    return feedbackError(401, 3401, "authentication_required");
  }
  if (isCreatePath) {
    if (request.method !== "POST") return feedbackError(405, 3405, "method_not_allowed");
    if (
      !(await consumeKvMinuteRateLimit(
        env.MIKIKO_SHARE,
        request,
        "fb-rl-create",
        CREATE_RATE_LIMIT_PER_MINUTE,
      ))
    ) {
      return feedbackError(429, 3402, "rate_limited");
    }
    return createFeedbackTicket(request, env);
  }
  const attachmentMatch = /^\/api\/v1\/feedback\/tickets\/([^/]+)\/attachments$/.exec(pathname);
  if (attachmentMatch) {
    if (request.method !== "POST") return feedbackError(405, 3405, "method_not_allowed");
    if (
      !(await consumeKvMinuteRateLimit(
        env.MIKIKO_SHARE,
        request,
        "fb-rl-attach",
        ATTACHMENT_RATE_LIMIT_PER_MINUTE,
      ))
    ) {
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
  const issuer = env.MIKIKO_OIDC_ISSUER?.trim() ?? "";
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
  // kind（Part C-b）：「给产品提需求」走 feature，其余默认 bug。
  const kind = body.kind === "feature" ? "feature" : "bug";
  // 账号归属（F.2）：携带 Mikiko ID Bearer 时必须验签成功（fail-close，不静默降匿名）。
  let owner: MikikoOidcIdentity | null = null;
  if (issuer && request.headers.get("authorization")) {
    try {
      owner = await requireMikikoOidcIdentity(request, issuer);
    } catch (error) {
      if (error instanceof MikikoOidcAuthError) {
        return feedbackError(error.status, 3410, error.code);
      }
      throw error;
    }
  }
  const environment =
    body.environment !== undefined &&
    typeof body.environment === "object" &&
    body.environment !== null
      ? body.environment
      : {};
  const environmentJson = JSON.stringify(environment);
  if (environmentJson.length > MAX_ENVIRONMENT_JSON_BYTES) {
    return feedbackError(400, 3403, "environment_too_large");
  }

  // 工单归属设备：从 token 解出 deviceHash（64 hex），无需信任 body 自报身份。
  // 账号（Mikiko ID）上报时 owner 已验签，归属以 owner_sub 为准，设备哈希留空。
  let deviceHash = "";
  if (owner === null) {
    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/u, "");
    deviceHash = token.split(".")[0] ?? "";
    if (!/^[0-9a-f]{64}$/u.test(deviceHash)) {
      return feedbackError(401, 3401, "authentication_required");
    }
  }

  const now = Date.now();
  const id = randomId("fb");
  await env.DB.prepare(
    `INSERT INTO feedback_tickets
       (id, client_ticket_id, kind, owner_sub, owner_email, device_hash, title, description,
        contact, environment_json, app_version, platform, locale, status, type, fix_version,
        assignee, attachment_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'pending_triage', NULL,
       NULL, NULL, 0, ?14, ?14)`,
  )
    .bind(
      id,
      clientTicketId,
      kind,
      owner?.sub ?? null,
      owner?.email ?? null,
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
  return feedbackData({ ticketId: id, status: "pending_triage", kind }, 201);
}

// ── 账号端点（Mikiko ID Bearer，F.2）──

async function listMyFeedbackTickets(
  request: Request,
  env: MikikoCloudFeedbackEnv,
  identity: MikikoOidcIdentity,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const pageSize = Math.min(
    Math.max(Number.parseInt(params.get("pageSize") ?? "20", 10) || 20, 1),
    100,
  );
  const page = Math.max(Number.parseInt(params.get("page") ?? "1", 10) || 1, 1);
  const status = params.get("status");
  const statusFilter =
    status !== null &&
    status !== "" &&
    (FEEDBACK_TICKET_STATUSES as readonly string[]).includes(status)
      ? " AND status = ?3"
      : "";
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM feedback_tickets WHERE owner_sub = ?1${statusFilter}`,
  )
    .bind(identity.sub, ...(statusFilter ? [status] : []))
    .first<{ total: number }>();
  const rows = await env.DB.prepare(
    `SELECT * FROM feedback_tickets WHERE owner_sub = ?1${statusFilter}
     ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(identity.sub, ...(statusFilter ? [status] : []), pageSize, (page - 1) * pageSize)
    .all<TicketRow>();
  return feedbackData({
    items: (rows.results ?? []).map(serializeTicket),
    total: totalRow?.total ?? 0,
    page,
    pageSize,
  });
}

async function getOwnFeedbackTicketDetail(
  env: MikikoCloudFeedbackEnv,
  identity: MikikoOidcIdentity,
  ticketId: string,
): Promise<Response> {
  const ticket = await loadTicket(env, ticketId);
  if (ticket === null) return feedbackError(404, 3404, "ticket_not_found");
  if (ticket.owner_sub !== identity.sub) return feedbackError(403, 3411, "ticket_not_owned");
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

async function createOwnFeedbackComment(
  request: Request,
  env: MikikoCloudFeedbackEnv,
  identity: MikikoOidcIdentity,
  ticketId: string,
): Promise<Response> {
  const ticket = await loadTicket(env, ticketId);
  if (ticket === null) return feedbackError(404, 3404, "ticket_not_found");
  if (ticket.owner_sub !== identity.sub) return feedbackError(403, 3411, "ticket_not_owned");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return feedbackError(400, 3403, "invalid_body");
  }
  const text = readString(body.body, 8000);
  if (text === undefined) return feedbackError(400, 3403, "invalid_body");
  const now = Date.now();
  const commentId = randomId("fc");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO feedback_comments (id, ticket_id, author, body, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    ).bind(commentId, ticketId, identity.email ?? "user", text, now),
    env.DB.prepare("UPDATE feedback_tickets SET updated_at = ?2 WHERE id = ?1").bind(ticketId, now),
  ]);
  return feedbackData({ commentId }, 201);
}

/** 本地历史工单幂等迁移：按 (owner_sub, client_ticket_id) 对账，已存在跳过、缺失补建。 */
async function migrateFeedbackTickets(
  request: Request,
  env: MikikoCloudFeedbackEnv,
  identity: MikikoOidcIdentity,
): Promise<Response> {
  let body: { records?: unknown };
  try {
    body = (await request.json()) as { records?: unknown };
  } catch {
    return feedbackError(400, 3403, "invalid_body");
  }
  const records = Array.isArray(body.records) ? body.records.slice(0, 200) : [];
  let migrated = 0;
  let skipped = 0;
  const now = Date.now();
  for (const entry of records) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const clientTicketId = readString(record.clientTicketId, 128);
    const title = readString(record.title, MAX_TITLE_LENGTH);
    const description = readString(record.description, MAX_DESCRIPTION_LENGTH);
    if (!clientTicketId || !title || !description) {
      skipped += 1;
      continue;
    }
    const existing = await env.DB.prepare(
      "SELECT id FROM feedback_tickets WHERE owner_sub = ?1 AND client_ticket_id = ?2",
    )
      .bind(identity.sub, clientTicketId)
      .first<{ id: string }>();
    if (existing !== null) {
      skipped += 1;
      continue;
    }
    // 认领优先：设备 token 时代的匿名行（owner 为空）按 client_ticket_id 认领到账号，
    // 避免同一条历史记录被 INSERT 成重复行（原行已存在远端，只是没有归属）。
    const claimResult = await env.DB.prepare(
      "UPDATE feedback_tickets SET owner_sub = ?1, owner_email = ?2, updated_at = ?4 WHERE client_ticket_id = ?3 AND owner_sub IS NULL",
    )
      .bind(identity.sub, identity.email ?? null, clientTicketId, now)
      .run();
    if ((claimResult.meta.changes ?? 0) > 0) {
      migrated += 1;
      continue;
    }
    const environment =
      record.environment !== undefined &&
      typeof record.environment === "object" &&
      record.environment !== null
        ? record.environment
        : {};
    const environmentJson = JSON.stringify(environment);
    if (environmentJson.length > MAX_ENVIRONMENT_JSON_BYTES) {
      skipped += 1;
      continue;
    }
    const createdAt =
      typeof record.createdAt === "number" && record.createdAt > 0 ? record.createdAt : now;
    await env.DB.prepare(
      `INSERT INTO feedback_tickets
         (id, client_ticket_id, kind, owner_sub, owner_email, device_hash, title, description,
          contact, environment_json, app_version, platform, locale, status, type, fix_version,
          assignee, attachment_count, created_at, updated_at)
       VALUES (?1, ?2, 'bug', ?3, ?4, '', ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending_triage', NULL,
         NULL, NULL, 0, ?12, ?12)`,
    )
      .bind(
        randomId("fb"),
        clientTicketId,
        identity.sub,
        identity.email ?? null,
        title,
        description,
        readString(record.contact, MAX_CONTACT_LENGTH) ?? null,
        environmentJson,
        readString(record.appVersion, 64) ?? null,
        readString(record.platform, 64) ?? null,
        readString(record.locale, 32) ?? null,
        createdAt,
      )
      .run();
    migrated += 1;
  }
  return feedbackData({ migrated, skipped });
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
