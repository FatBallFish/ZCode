import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/** 后台 API 客户端：admin session cookie（SameSite=Lax）同源直连。 */

export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    credentials: "same-origin",
  });
  if (response.status === 401) {
    throw new AdminApiError("登录已过期，请重新登录", 401);
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string; message?: string };
    throw new AdminApiError(detail.message ?? detail.error ?? `HTTP ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

// ── 信封形状（worker 各端点差异）──

interface FeedbackEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

export interface FeedbackTicket {
  id: string;
  clientTicketId: string | null;
  kind: "bug" | "feature" | string;
  ownerEmail: string | null;
  title: string;
  description: string;
  contact: string | null;
  environment: unknown;
  appVersion: string | null;
  platform: string | null;
  locale: string | null;
  status: string;
  type: string | null;
  fixVersion: string | null;
  assignee: string | null;
  attachmentCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface FeedbackComment {
  id: string;
  ticketId: string;
  author: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface FeedbackAttachment {
  id: string;
  ticketId: string;
  kind: string;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: number;
}

export const FEEDBACK_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "pending_triage", label: "待定位" },
  { value: "triaging", label: "定位中" },
  { value: "located", label: "已定位" },
  { value: "not_issue", label: "非问题" },
  { value: "awaiting_release", label: "待出包" },
  { value: "resolved", label: "已解决" },
];

export const FEEDBACK_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "legacy_bug", label: "历史Bug" },
  { value: "new_regression", label: "新引入缺陷" },
  { value: "config_issue", label: "配置问题" },
  { value: "product_misunderstanding", label: "产品理解问题" },
  { value: "env_data_anomaly", label: "环境数据异常" },
  { value: "product_design", label: "产品设计问题" },
  { value: "other", label: "其他" },
];

export function statusLabel(status: string): string {
  return FEEDBACK_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status;
}

export function typeLabel(type: string | null): string {
  if (!type) return "—";
  return FEEDBACK_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type;
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

// ── 会话 ──

export const api = {
  async login(username: string, password: string): Promise<void> {
    await request("/api/v1/admin/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  },
  async logout(): Promise<void> {
    await request("/api/v1/admin/logout", { method: "POST" });
  },
  async probe(): Promise<boolean> {
    const response = await fetch("/api/v1/admin/feedback/tickets?pageSize=1", {
      credentials: "same-origin",
    });
    return response.ok;
  },

  listTickets(params: {
    status?: string;
    type?: string;
    kind?: string;
    owner?: string;
    q?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: FeedbackTicket[]; total: number; page: number; pageSize: number }> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") search.set(key, String(value));
    }
    return request<FeedbackEnvelope<{ items: FeedbackTicket[]; total: number; page: number; pageSize: number }>>(
      `/api/v1/admin/feedback/tickets?${search.toString()}`,
    ).then((envelope) => envelope.data);
  },
  ticketDetail(id: string): Promise<{
    ticket: FeedbackTicket;
    comments: FeedbackComment[];
    attachments: FeedbackAttachment[];
  }> {
    return request<FeedbackEnvelope<{
      ticket: FeedbackTicket;
      comments: FeedbackComment[];
      attachments: FeedbackAttachment[];
    }>>(`/api/v1/admin/feedback/tickets/${encodeURIComponent(id)}`).then((envelope) => envelope.data);
  },
  patchTicket(
    id: string,
    body: { status?: string; type?: string | null; fixVersion?: string | null; assignee?: string | null },
  ): Promise<void> {
    return request(`/api/v1/admin/feedback/tickets/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },
  deleteTicket(id: string): Promise<void> {
    return request(`/api/v1/admin/feedback/tickets/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  addComment(id: string, author: string, body: string): Promise<void> {
    return request(`/api/v1/admin/feedback/tickets/${encodeURIComponent(id)}/comments`, {
      method: "POST",
      body: JSON.stringify({ author, body }),
    });
  },
  updateComment(ticketId: string, commentId: string, body: string, author?: string): Promise<void> {
    return request(
      `/api/v1/admin/feedback/tickets/${encodeURIComponent(ticketId)}/comments/${encodeURIComponent(commentId)}`,
      { method: "PATCH", body: JSON.stringify({ body, ...(author ? { author } : {}) }) },
    );
  },
  deleteComment(ticketId: string, commentId: string): Promise<void> {
    return request(
      `/api/v1/admin/feedback/tickets/${encodeURIComponent(ticketId)}/comments/${encodeURIComponent(commentId)}`,
      { method: "DELETE" },
    );
  },
  attachmentUrl(ticketId: string, attachmentId: string, inline = false): string {
    return `/api/v1/admin/feedback/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(
      attachmentId,
    )}${inline ? "?disposition=inline" : ""}`;
  },

  getBuiltinConfig(): Promise<{ schemaVersion: number; revision: number; config: unknown }> {
    return request("/api/v1/admin/builtin-config");
  },
  putBuiltinConfig(config: unknown): Promise<{ revision: number }> {
    return request("/api/v1/admin/builtin-config", { method: "PUT", body: JSON.stringify({ config }) });
  },
  builtinHistory(): Promise<Array<{ revision: number; updatedAt?: number }>> {
    return request<{ entries?: Array<{ revision: number; updatedAt?: number }> }>(
      "/api/v1/admin/builtin-config/history",
    ).then((body) => body.entries ?? []);
  },
  restoreBuiltinConfig(revision: number): Promise<{ revision: number }> {
    return request(`/api/v1/admin/builtin-config/history/${revision}`, { method: "POST" }).then(() =>
      request<{ revision: number }>("/api/v1/admin/builtin-config"),
    );
  },
  getClientConfigs(): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>("/api/v1/admin/client-configs");
  },
  putClientConfigs(configs: Record<string, unknown>): Promise<void> {
    return request("/api/v1/admin/client-configs", { method: "PUT", body: JSON.stringify(configs) });
  },
};

// ── 会话上下文 ──

interface SessionContextValue {
  ready: boolean;
  authenticated: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    void api
      .probe()
      .then(setAuthenticated)
      .catch(() => setAuthenticated(false))
      .finally(() => setReady(true));
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    await api.login(username, password);
    setAuthenticated(true);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setAuthenticated(false);
  }, []);

  return (
    <SessionContext.Provider value={{ ready, authenticated, signIn, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession 必须在 SessionProvider 内使用");
  return value;
}
