/** 管理路由只在 worker.ts 完成 admin session 鉴权后执行；客户端账号授权留在 feedback.ts。 */
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
  FEEDBACK_TICKET_TYPES,
  type MikikoCloudFeedbackEnv,
  type TicketRow,
  type CommentRow,
  type AttachmentRow,
} from "./feedbackModel.js";

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
    if (request.method === "DELETE") return deleteFeedbackTicket(env, ticketId);
    return feedbackError(405, 3405, "method_not_allowed");
  }
  match = /^\/api\/v1\/admin\/feedback\/tickets\/([^/]+)\/attachments\/([^/]+)$/.exec(pathname);
  if (match) {
    if (request.method !== "GET") return feedbackError(405, 3405, "method_not_allowed");
    return downloadFeedbackAttachment(
      request,
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

/** 删除工单（2026-10-20 D.5）：D1 级联（schema ON DELETE CASCADE）+ R2 对象清理。
 *  R2 清理失败仅记日志不阻塞——对象孤儿可由 bucket 生命周期策略兜底。 */
async function deleteFeedbackTicket(
  env: MikikoCloudFeedbackEnv,
  ticketId: string,
): Promise<Response> {
  const ticket = await loadTicket(env, ticketId);
  if (ticket === null) return feedbackError(404, 3404, "ticket_not_found");
  try {
    const prefix = `feedback/${ticketId}/`;
    let cursor: string | undefined;
    do {
      const listing = await env.FEEDBACK_ARTIFACTS.list({ prefix, cursor });
      for (const object of listing.objects ?? []) {
        await env.FEEDBACK_ARTIFACTS.delete(object.key);
      }
      cursor = listing.truncated ? (listing.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
  } catch {
    // R2 清理 best-effort：DB 行删除仍执行，避免留下不可再删除的工单。
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM feedback_comments WHERE ticket_id = ?1").bind(ticketId),
    env.DB.prepare("DELETE FROM feedback_attachments WHERE ticket_id = ?1").bind(ticketId),
    env.DB.prepare("DELETE FROM feedback_tickets WHERE id = ?1").bind(ticketId),
  ]);
  return feedbackData({ deleted: ticketId });
}

async function listFeedbackTickets(
  request: Request,
  env: MikikoCloudFeedbackEnv,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const pageSize = Math.min(
    Math.max(Number.parseInt(params.get("pageSize") ?? "20", 10) || 20, 1),
    100,
  );
  const page = Math.max(Number.parseInt(params.get("page") ?? "1", 10) || 1, 1);
  const status = params.get("status");
  const type = params.get("type");
  const kind = params.get("kind");
  const owner = params.get("owner");
  const keyword = params.get("q");

  const where: string[] = [];
  const binds: unknown[] = [];
  if (
    status !== null &&
    status !== "" &&
    (FEEDBACK_TICKET_STATUSES as readonly string[]).includes(status)
  ) {
    where.push("status = ?");
    binds.push(status);
  }
  if (type !== null && type !== "" && (FEEDBACK_TICKET_TYPES as readonly string[]).includes(type)) {
    where.push("type = ?");
    binds.push(type);
  }
  if (kind === "bug" || kind === "feature") {
    where.push("kind = ?");
    binds.push(kind);
  }
  if (owner !== null && owner.trim().length > 0) {
    where.push("owner_email = ?");
    binds.push(owner.trim());
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
  if (body.fixVersion !== undefined)
    updates.push({ column: "fix_version", value: fixVersion ?? null });
  const assignee = readString(body.assignee ?? "", 64);
  if (body.assignee !== undefined) updates.push({ column: "assignee", value: assignee ?? null });

  if (updates.length === 0) return feedbackError(400, 3403, "no_fields_to_update");

  const setClause = updates.map((update) => `${update.column} = ?`).join(", ");
  const binds: unknown[] = [...updates.map((update) => update.value), Date.now(), ticketId];
  await env.DB.prepare(`UPDATE feedback_tickets SET ${setClause}, updated_at = ? WHERE id = ?`)
    .bind(...binds)
    .run();
  const updated = await loadTicket(env, ticketId);
  return feedbackData({ ticket: updated === null ? null : serializeTicket(updated) });
}

async function downloadFeedbackAttachment(
  request: Request,
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
      // 2026-10-20 D.6：?disposition=inline 供后台截图灯箱预览；仅图片类型放行 inline，
      // zip 日志归档等其余类型一律 attachment，避免浏览器内联执行风险。
      "content-disposition": `${new URL(request.url).searchParams.get("disposition") === "inline" && row.content_type.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodedName}`,
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
