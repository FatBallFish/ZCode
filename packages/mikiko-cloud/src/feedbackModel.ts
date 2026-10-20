/** 反馈工单共享行模型与 HTTP 信封；D1/R2 仍由请求处理器持有，不引入缓存或第二状态源。 */
export interface MikikoCloudFeedbackEnv {
  DB: D1Database;
  MIKIKO_SHARE: KVNamespace;
  FEEDBACK_ARTIFACTS: R2Bucket;
  /** Mikiko ID issuer（wrangler [vars]）；缺省反馈账号端点不可用（503）。 */
  MIKIKO_OIDC_ISSUER?: string;
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

export function feedbackData(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, msg: "", data }), {
    status,
    headers: JSON_HEADERS,
  });
}

export function feedbackError(status: number, code: number, msg: string): Response {
  return new Response(JSON.stringify({ code, msg }), { status, headers: JSON_HEADERS });
}

export function randomId(prefix: string): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  return `${prefix}_${[...raw].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function readString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > max ? undefined : trimmed;
}

export interface TicketRow {
  id: string;
  client_ticket_id: string | null;
  kind: string;
  owner_sub: string | null;
  owner_email: string | null;
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

export interface CommentRow {
  id: string;
  ticket_id: string;
  author: string;
  body: string;
  created_at: number;
  updated_at: number;
}

export interface AttachmentRow {
  id: string;
  ticket_id: string;
  kind: string;
  file_name: string;
  content_type: string;
  size: number;
  r2_key: string;
  created_at: number;
}

export function serializeTicket(row: TicketRow) {
  return {
    id: row.id,
    clientTicketId: row.client_ticket_id,
    kind: row.kind,
    ownerEmail: row.owner_email,
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

export function serializeComment(row: CommentRow) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeAttachment(row: AttachmentRow) {
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

export async function loadTicket(
  env: MikikoCloudFeedbackEnv,
  ticketId: string,
): Promise<TicketRow | null> {
  return env.DB.prepare("SELECT * FROM feedback_tickets WHERE id = ?1")
    .bind(ticketId)
    .first<TicketRow>();
}
