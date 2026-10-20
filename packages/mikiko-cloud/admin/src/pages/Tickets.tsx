import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  FEEDBACK_STATUS_OPTIONS,
  FEEDBACK_TYPE_OPTIONS,
  formatTime,
  statusLabel,
  type FeedbackAttachment,
  type FeedbackComment,
  type FeedbackTicket,
} from "../lib/api.tsx";

/**
 * 工单/产品需求列表 + 详情抽屉（方案 D.5/D.6）：
 * - 首列标题、时间后置、操作列（状态直改 + 删除 + 详情）；
 * - 抽屉左右两栏：左侧工单详情（行内编辑 + 截图灯箱预览/附件下载），右侧评论时间轴 + 新评论。
 */
export function TicketsPage({ kind }: { kind: "bug" | "feature" }) {
  const [tickets, setTickets] = useState<FeedbackTicket[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const pageSize = 20;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listTickets({ kind, status, type, q: keyword, page, pageSize });
      setTickets(result.items);
      setTotal(result.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [kind, status, type, keyword, page]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const changeStatus = async (ticket: FeedbackTicket, next: string) => {
    await api.patchTicket(ticket.id, { status: next });
    await reload();
  };

  const removeTicket = async (ticket: FeedbackTicket) => {
    if (!window.confirm(`确定删除工单「${ticket.title}」？评论与附件将一并删除。`)) return;
    await api.deleteTicket(ticket.id);
    if (detailId === ticket.id) setDetailId(null);
    await reload();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={keyword}
          onChange={(event) => {
            setKeyword(event.target.value);
            setPage(1);
          }}
          placeholder="搜索标题/描述…"
          className="h-9 w-56 rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm outline-none focus:border-amber-500"
        />
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
          className="h-9 rounded-lg border border-neutral-700 bg-neutral-900 px-2 text-sm"
        >
          <option value="">全部状态</option>
          {FEEDBACK_STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {kind === "bug" && (
          <select
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setPage(1);
            }}
            className="h-9 rounded-lg border border-neutral-700 bg-neutral-900 px-2 text-sm"
          >
            <option value="">全部类型</option>
            {FEEDBACK_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        <span className="ml-auto text-xs text-neutral-500">
          共 {total} 条{loading ? " · 加载中…" : ""}
        </span>
      </div>

      {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-neutral-800">
        <table className="w-full min-w-[52rem] text-sm">
          <thead>
            <tr className="border-b border-neutral-800 bg-neutral-900/60 text-left text-xs text-neutral-400">
              <th className="px-4 py-2.5 font-medium">标题</th>
              <th className="px-3 py-2.5 font-medium">状态</th>
              {kind === "bug" && <th className="px-3 py-2.5 font-medium">类型</th>}
              <th className="px-3 py-2.5 font-medium">账号</th>
              <th className="px-3 py-2.5 font-medium">附件</th>
              <th className="px-3 py-2.5 font-medium">更新时间</th>
              <th className="px-3 py-2.5 font-medium">创建时间</th>
              <th className="px-3 py-2.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((ticket) => (
              <tr key={ticket.id} className="border-b border-neutral-800/60 last:border-0 hover:bg-neutral-900/40">
                <td className="max-w-[18rem] truncate px-4 py-2.5">
                  <button
                    type="button"
                    title={ticket.title}
                    onClick={() => setDetailId(ticket.id)}
                    className="text-left hover:text-amber-300"
                  >
                    {ticket.title}
                  </button>
                </td>
                <td className="px-3 py-2.5">
                  <StatusBadge status={ticket.status} />
                </td>
                {kind === "bug" && (
                  <td className="px-3 py-2.5 text-neutral-400">
                    {FEEDBACK_TYPE_OPTIONS.find((option) => option.value === ticket.type)?.label ?? "—"}
                  </td>
                )}
                <td className="max-w-[12rem] truncate px-3 py-2.5 text-neutral-400" title={ticket.ownerEmail ?? ""}>
                  {ticket.ownerEmail ?? "匿名设备"}
                </td>
                <td className="px-3 py-2.5 text-neutral-400">{ticket.attachmentCount}</td>
                <td className="px-3 py-2.5 text-neutral-500">{formatTime(ticket.updatedAt)}</td>
                <td className="px-3 py-2.5 text-neutral-500">{formatTime(ticket.createdAt)}</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <select
                      value={ticket.status}
                      onChange={(event) => void changeStatus(ticket, event.target.value)}
                      className="h-7 rounded border border-neutral-700 bg-neutral-900 px-1 text-xs"
                    >
                      {FEEDBACK_STATUS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setDetailId(ticket.id)}
                      className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:border-amber-500 hover:text-amber-300"
                    >
                      详情
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeTicket(ticket)}
                      className="rounded border border-red-900/60 px-2 py-0.5 text-xs text-red-400 hover:border-red-500"
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {tickets.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-neutral-600">
                  暂无记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-end gap-3 text-sm text-neutral-400">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage((value) => Math.max(1, value - 1))}
          className="rounded-lg border border-neutral-700 px-3 py-1 disabled:opacity-30"
        >
          上一页
        </button>
        <span>
          {page} / {totalPages}
        </span>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => setPage((value) => value + 1)}
          className="rounded-lg border border-neutral-700 px-3 py-1 disabled:opacity-30"
        >
          下一页
        </button>
      </div>

      {detailId && <TicketDrawer ticketId={detailId} onClose={() => setDetailId(null)} onChanged={reload} />}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "resolved"
      ? "bg-emerald-500/15 text-emerald-400"
      : status === "not_issue"
        ? "bg-neutral-700/40 text-neutral-400"
        : status === "awaiting_release"
          ? "bg-sky-500/15 text-sky-400"
          : status === "pending_triage"
            ? "bg-amber-500/15 text-amber-300"
            : "bg-orange-500/15 text-orange-300";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {statusLabel(status)}
    </span>
  );
}

interface TicketDetail {
  ticket: FeedbackTicket;
  comments: FeedbackComment[];
  attachments: FeedbackAttachment[];
}

function TicketDrawer({
  ticketId,
  onClose,
  onChanged,
}: {
  ticketId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ status: "", type: "", fixVersion: "", assignee: "" });
  const [commentAuthor, setCommentAuthor] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [lightbox, setLightbox] = useState<FeedbackAttachment | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await api.ticketDetail(ticketId);
      setDetail(next);
      setForm({
        status: next.ticket.status,
        type: next.ticket.type ?? "",
        fixVersion: next.ticket.fixVersion ?? "",
        assignee: next.ticket.assignee ?? "",
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [ticketId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (lightbox) setLightbox(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, onClose]);

  const saveForm = async () => {
    if (!detail) return;
    await api.patchTicket(ticketId, {
      status: form.status,
      type: form.type || null,
      fixVersion: form.fixVersion || null,
      assignee: form.assignee || null,
    });
    setEditing(false);
    await reload();
    await onChanged();
  };

  const submitComment = async () => {
    if (!commentAuthor.trim() || !commentBody.trim()) return;
    setCommentBusy(true);
    try {
      await api.addComment(ticketId, commentAuthor.trim(), commentBody.trim());
      setCommentBody("");
      await reload();
      await onChanged();
    } finally {
      setCommentBusy(false);
    }
  };

  const screenshots = useMemo(
    () => (detail?.attachments ?? []).filter((item) => item.contentType.startsWith("image/")),
    [detail],
  );
  const archives = useMemo(
    () => (detail?.attachments ?? []).filter((item) => !item.contentType.startsWith("image/")),
    [detail],
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={onClose}>
      <div
        className="flex h-full w-[min(60rem,92vw)] flex-col gap-0 overflow-hidden bg-neutral-950 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <h2 className="min-w-0 truncate text-base font-semibold" title={detail?.ticket.title}>
            {detail?.ticket.title ?? "加载中…"}
          </h2>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-neutral-500 hover:bg-neutral-800">
            ✕
          </button>
        </header>
        {error && <p className="px-6 py-2 text-sm text-red-400">{error}</p>}
        {!detail ? (
          <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">读取详情…</div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[1.15fr_0.85fr]">
            {/* 左栏：工单详情 */}
            <div className="min-h-0 space-y-5 overflow-y-auto border-r border-neutral-800 px-6 py-5">
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-neutral-300">跟进信息</h3>
                  {editing ? (
                    <div className="flex gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => void saveForm()}
                        className="rounded bg-amber-500 px-2.5 py-1 font-medium text-neutral-950"
                      >
                        保存
                      </button>
                      <button type="button" onClick={() => setEditing(false)} className="rounded border border-neutral-700 px-2.5 py-1">
                        取消
                      </button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setEditing(true)} className="text-xs text-amber-400 hover:underline">
                      编辑
                    </button>
                  )}
                </div>
                {editing ? (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1 text-xs text-neutral-500">
                      状态
                      <select
                        value={form.status}
                        onChange={(event) => setForm({ ...form, status: event.target.value })}
                        className="h-8 w-full rounded border border-neutral-700 bg-neutral-900 px-2 text-sm text-neutral-200"
                      >
                        {FEEDBACK_STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-xs text-neutral-500">
                      类型
                      <select
                        value={form.type}
                        onChange={(event) => setForm({ ...form, type: event.target.value })}
                        className="h-8 w-full rounded border border-neutral-700 bg-neutral-900 px-2 text-sm text-neutral-200"
                      >
                        <option value="">未归类</option>
                        {FEEDBACK_TYPE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-xs text-neutral-500">
                      修复版本
                      <input
                        value={form.fixVersion}
                        onChange={(event) => setForm({ ...form, fixVersion: event.target.value })}
                        className="h-8 w-full rounded border border-neutral-700 bg-neutral-900 px-2 text-sm text-neutral-200"
                      />
                    </label>
                    <label className="space-y-1 text-xs text-neutral-500">
                      跟进人
                      <input
                        value={form.assignee}
                        onChange={(event) => setForm({ ...form, assignee: event.target.value })}
                        className="h-8 w-full rounded border border-neutral-700 bg-neutral-900 px-2 text-sm text-neutral-200"
                      />
                    </label>
                  </div>
                ) : (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                    <Row label="状态" value={<StatusBadge status={detail.ticket.status} />} />
                    <Row label="类型" value={FEEDBACK_TYPE_OPTIONS.find((o) => o.value === detail.ticket.type)?.label ?? "未归类"} muted />
                    <Row label="修复版本" value={detail.ticket.fixVersion ?? "—"} muted />
                    <Row label="跟进人" value={detail.ticket.assignee ?? "—"} muted />
                    <Row label="账号" value={detail.ticket.ownerEmail ?? "匿名设备"} muted />
                    <Row label="联系方式" value={detail.ticket.contact ?? "—"} muted />
                    <Row label="版本/平台" value={`${detail.ticket.appVersion ?? "?"} · ${detail.ticket.platform ?? "?"}`} muted />
                    <Row label="客户端记录" value={detail.ticket.clientTicketId ?? "—"} muted />
                  </dl>
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-medium text-neutral-300">描述</h3>
                <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-neutral-900/60 p-3 text-xs leading-relaxed text-neutral-300">
                  {detail.ticket.description}
                </pre>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-medium text-neutral-300">环境快照</h3>
                <pre className="max-h-40 overflow-y-auto rounded-lg bg-neutral-900/60 p-3 text-[11px] leading-relaxed text-neutral-500">
                  {JSON.stringify(detail.ticket.environment, null, 2)}
                </pre>
              </section>

              {screenshots.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-sm font-medium text-neutral-300">截图（{screenshots.length}）</h3>
                  <div className="grid grid-cols-3 gap-2">
                    {screenshots.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setLightbox(item)}
                        className="group relative overflow-hidden rounded-lg border border-neutral-800"
                      >
                        <img
                          src={api.attachmentUrl(detail.ticket.id, item.id, true)}
                          alt={item.fileName}
                          className="aspect-video w-full object-cover transition group-hover:opacity-80"
                        />
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {archives.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-sm font-medium text-neutral-300">附件（{archives.length}）</h3>
                  <div className="space-y-1.5">
                    {archives.map((item) => (
                      <a
                        key={item.id}
                        href={api.attachmentUrl(detail.ticket.id, item.id)}
                        className="flex items-center justify-between rounded-lg border border-neutral-800 px-3 py-2 text-xs hover:border-amber-500/60"
                      >
                        <span className="truncate">{item.fileName}</span>
                        <span className="ml-3 shrink-0 text-neutral-500">{(item.size / 1024 / 1024).toFixed(1)} MB · 下载</span>
                      </a>
                    ))}
                  </div>
                </section>
              )}
            </div>

            {/* 右栏：评论时间轴 + 新评论 */}
            <div className="flex min-h-0 flex-col">
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
                <h3 className="text-sm font-medium text-neutral-300">评论时间轴（{detail.comments.length}）</h3>
                {detail.comments.map((comment) => (
                  <CommentItem
                    key={comment.id}
                    comment={comment}
                    ticketId={detail.ticket.id}
                    onChanged={async () => {
                      await reload();
                      await onChanged();
                    }}
                  />
                ))}
                {detail.comments.length === 0 && (
                  <p className="rounded-lg border border-dashed border-neutral-800 px-4 py-6 text-center text-xs text-neutral-600">
                    暂无评论
                  </p>
                )}
              </div>
              <div className="space-y-2 border-t border-neutral-800 px-5 py-4">
                <div className="flex gap-2">
                  <input
                    value={commentAuthor}
                    onChange={(event) => setCommentAuthor(event.target.value)}
                    placeholder="署名"
                    className="h-8 w-28 rounded border border-neutral-700 bg-neutral-900 px-2 text-xs"
                  />
                  <input
                    value={commentBody}
                    onChange={(event) => setCommentBody(event.target.value)}
                    placeholder="新评论（根因/处理进展/发布备注…）"
                    className="h-8 min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 text-xs"
                  />
                </div>
                <button
                  type="button"
                  disabled={commentBusy || !commentAuthor.trim() || !commentBody.trim()}
                  onClick={() => void submitComment()}
                  className="w-full rounded-lg bg-amber-500 py-1.5 text-xs font-semibold text-neutral-950 disabled:opacity-40"
                >
                  {commentBusy ? "提交中…" : "发表评论"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8"
          onClick={() => setLightbox(null)}
        >
          <img
            src={api.attachmentUrl(lightbox.ticketId, lightbox.id, true)}
            alt={lightbox.fileName}
            className="max-h-full max-w-full rounded-lg"
          />
          <a
            href={api.attachmentUrl(lightbox.ticketId, lightbox.id)}
            onClick={(event) => event.stopPropagation()}
            className="absolute right-6 top-5 rounded-lg border border-neutral-700 bg-neutral-900/80 px-3 py-1.5 text-xs text-neutral-300"
          >
            下载原图
          </a>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-xs text-neutral-500">{label}</dt>
      <dd className={`min-w-0 break-words text-sm ${muted ? "text-neutral-400" : ""}`}>{value}</dd>
    </div>
  );
}

function CommentItem({
  comment,
  ticketId,
  onChanged,
}: {
  comment: FeedbackComment;
  ticketId: string;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);

  const save = async () => {
    await api.updateComment(ticketId, comment.id, draft);
    setEditing(false);
    await onChanged();
  };

  return (
    <div className="relative rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 pl-4">
      <span className="absolute left-1.5 top-4 h-1.5 w-1.5 rounded-full bg-amber-500/70" />
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-amber-300/90">{comment.author}</span>
        <span className="text-[10px] text-neutral-600">
          {formatTime(comment.createdAt)}
          {comment.updatedAt !== comment.createdAt ? " · 已编辑" : ""}
        </span>
      </div>
      {editing ? (
        <div className="mt-1.5 space-y-1.5">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            className="w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-xs"
          />
          <div className="flex gap-2 text-xs">
            <button type="button" onClick={() => void save()} className="rounded bg-amber-500 px-2 py-0.5 font-medium text-neutral-950">
              保存
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(comment.body);
              }}
              className="rounded border border-neutral-700 px-2 py-0.5"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-neutral-300">{comment.body}</p>
      )}
      {!editing && (
        <div className="mt-1 flex gap-3 text-[10px] text-neutral-600">
          <button type="button" onClick={() => setEditing(true)} className="hover:text-neutral-400">
            编辑
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!window.confirm("删除该评论？")) return;
              await api.deleteComment(ticketId, comment.id);
              await onChanged();
            }}
            className="hover:text-red-400"
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}
