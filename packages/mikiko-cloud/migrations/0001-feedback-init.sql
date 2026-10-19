-- Bug 上报 + 工单管理（specs/mikiko-cloud/feedback-tickets.md）初始 schema。
-- 状态/类型为机器码字符串，枚举封闭在 src/feedback.ts（admin UI 维护中文文案映射）。

CREATE TABLE IF NOT EXISTS feedback_tickets (
  id TEXT PRIMARY KEY,
  -- 客户端本地记录 id：本地优先记录与云端工单对账；未来 OAuth 迁移历史离线数据时使用。
  client_ticket_id TEXT,
  -- 归属设备 = sha256(deviceMid)（设备 token 注册身份，原始 mid 不落库）。
  device_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  contact TEXT,
  environment_json TEXT NOT NULL,
  app_version TEXT,
  platform TEXT,
  locale TEXT,
  status TEXT NOT NULL DEFAULT 'pending_triage',
  type TEXT,
  fix_version TEXT,
  assignee TEXT,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_tickets_created ON feedback_tickets (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_tickets_status ON feedback_tickets (status);

CREATE TABLE IF NOT EXISTS feedback_attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES feedback_tickets (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_attachments_ticket ON feedback_attachments (ticket_id, created_at);

CREATE TABLE IF NOT EXISTS feedback_comments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES feedback_tickets (id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_comments_ticket ON feedback_comments (ticket_id, created_at);
