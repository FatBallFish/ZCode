-- 0002：反馈账户化 + 产品需求模块（docs/mikiko-id-integration-plan.md D.4/F.2）
-- kind：'bug'（默认）| 'feature'（给产品提需求，Part C-b）
-- owner_sub/owner_email：Mikiko ID（KeyCloak）sub 与邮箱；NULL = 匿名（设备 token）/历史数据。
ALTER TABLE feedback_tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'bug';
ALTER TABLE feedback_tickets ADD COLUMN owner_sub TEXT;
ALTER TABLE feedback_tickets ADD COLUMN owner_email TEXT;
CREATE INDEX idx_feedback_tickets_owner ON feedback_tickets(owner_sub, updated_at DESC);
CREATE INDEX idx_feedback_tickets_kind ON feedback_tickets(kind, updated_at DESC);
CREATE UNIQUE INDEX idx_feedback_tickets_owner_client
  ON feedback_tickets(owner_sub, client_ticket_id)
  WHERE owner_sub IS NOT NULL AND client_ticket_id IS NOT NULL;
