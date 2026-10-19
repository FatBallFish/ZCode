import { readFile, stat } from "node:fs/promises";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { redactFeedbackText } from "@zcode/shared";
import type {
  CreateFeedbackTicketInput,
  FeedbackAttachment,
  FeedbackAttachmentKind,
  FeedbackDeviceInfo,
  FeedbackTicketDetail,
} from "@zcode/shared";
import type { ApiClient } from "@zcode/shared";

/** UI 按 error.name 识别取消（feedbackSubmissionJob），保持既有契约。 */
export class FeedbackUploadCanceledError extends Error {
  constructor() {
    super("Feedback upload canceled");
    this.name = "FeedbackUploadCanceledError";
  }
}

/**
 * Mikiko 自建 Bug 上报 HTTP 客户端（specs/mikiko-cloud/feedback-tickets.md）。
 *
 * 协议与旧智谱官方客户端（feedbackHttpClient，OSS 直传 + JWT）完全不同：
 *  - 鉴权：设备 token（Bearer，注册见 mikikoShareDeviceToken.resolveMikikoFeedbackDeviceToken）；
 *  - 创建：POST {base}/feedback/tickets，JSON 信封 {code, msg, data}；
 *  - 附件：POST {base}/feedback/tickets/{id}/attachments，二进制 Worker 中转到 R2
 *    （无分片/无凭证换取，fetch 单请求；进度只报 preparing → complete 两态）。
 * 401 时清 token 重注册重试一次（沿用分享链路的 3201 自愈语义）。
 */

const log = createServiceLogger("mikiko-feedback-client");
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 180_000;

export class MikikoFeedbackRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "MikikoFeedbackRequestError";
  }
}

export interface MikikoFeedbackHttpClientOptions {
  baseUrl: string;
  apiClient: ApiClient;
  getDeviceToken: () => Promise<string | null>;
  /** 401 自愈：清缓存重注册后重试一次。 */
  reacquireDeviceToken: () => Promise<string | null>;
  getDeviceMid?: () => string | undefined;
}

interface FeedbackEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

export class MikikoFeedbackHttpClient {
  constructor(private readonly options: MikikoFeedbackHttpClientOptions) {}

  private async authedRequest(
    path: string,
    init: {
      method: string;
      body?: string | Uint8Array;
      headers?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
    allowRetry = true,
  ): Promise<Response> {
    const token = await this.options.getDeviceToken();
    const headers: Record<string, string> = { ...init.headers };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await this.options.apiClient.request(`${this.options.baseUrl}${path}`, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
      credentials: "omit",
      timeoutMs: init.timeoutMs ?? REQUEST_TIMEOUT_MS,
    });
    if (response.status === 401 && allowRetry) {
      const refreshed = await this.options.reacquireDeviceToken();
      if (refreshed && refreshed !== token) {
        return this.authedRequest(path, init, false);
      }
    }
    if (!response.ok) {
      const detail = await readErrorMessage(response);
      log.warn(undefined, "Mikiko 反馈请求失败", { path, status: response.status, detail });
      throw new MikikoFeedbackRequestError(response.status, undefined, detail);
    }
    return response;
  }

  async create(
    input: CreateFeedbackTicketInput & { device: FeedbackDeviceInfo },
    options?: { signal?: AbortSignal; clientTicketId?: string },
  ): Promise<FeedbackTicketDetail> {
    const body: Record<string, unknown> = {
      // 脱敏管线与旧客户端一致（feedbackPrivacy）：title/description/contact 出网前
      // 必须过 redactFeedbackText，环境快照整体序列化后同样脱敏。
      title: redactFeedbackText(input.title),
      description: redactFeedbackText(input.description),
      contact: input.contact ? redactFeedbackText(input.contact) : input.contact,
      environment: JSON.parse(
        redactFeedbackText(
          JSON.stringify({
            ...input.device,
            ...(input.source ? { source: input.source } : {}),
            ...(input.framework ? { framework: input.framework } : {}),
            ...(input.locale ? { locale: input.locale } : {}),
          }),
        ),
      ) as Record<string, unknown>,
      appVersion: input.device.appVersion,
      platform: input.device.osPlatform && input.device.osArch
        ? `${input.device.osPlatform}-${input.device.osArch}`
        : undefined,
      locale: input.locale,
      ...(options?.clientTicketId ? { clientTicketId: options.clientTicketId } : {}),
    };
    const response = await this.authedRequest("/feedback/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    const envelope = (await response.json()) as FeedbackEnvelope<{ ticketId?: unknown; status?: unknown }>;
    assertEnvelopeOk(envelope);
    const ticketId = envelope.data?.ticketId;
    if (typeof ticketId !== "string" || !ticketId) {
      throw new MikikoFeedbackRequestError(response.status, envelope.code, "invalid_create_response");
    }
    const now = new Date().toISOString();
    return {
      id: ticketId,
      title: input.title,
      type: input.type,
      severity: input.severity,
      module: input.module,
      status: "已提交",
      assignee_id: null,
      assignee_display: null,
      reporter_display: input.reporter?.display_name ?? null,
      created_at: now,
      updated_at: now,
      description: input.description,
      framework: input.framework,
      reporter: input.reporter ?? null,
      device: input.device,
      attachments: [],
      comments: [],
      events: [
        {
          id: 1,
          type: "created",
          summary: "工单已提交",
          created_at: now,
        },
      ],
      lark_record_id: null,
    };
  }

  async uploadFile(
    ticketId: string,
    kind: FeedbackAttachmentKind,
    path: string,
    filename: string,
    contentType: string,
    options?: {
      onUploadProgress?: (event: { uploadedBytes: number; totalBytes: number }) => void;
      signal?: AbortSignal;
    },
  ): Promise<FeedbackAttachment> {
    const [buffer, fileInfo] = await Promise.all([readFile(path), stat(path)]);
    options?.onUploadProgress?.({ uploadedBytes: 0, totalBytes: buffer.byteLength });
    const headerKind = kind === "image" ? "screenshot" : "log";
    let response: Response;
    try {
      response = await this.authedRequest(
        `/feedback/tickets/${encodeURIComponent(ticketId)}/attachments`,
        {
          method: "POST",
          headers: {
            "content-type": contentType,
            "x-attachment-kind": headerKind,
            "x-file-name": encodeURIComponent(filename),
          },
          body: new Uint8Array(buffer),
          timeoutMs: UPLOAD_TIMEOUT_MS,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        },
      );
    } catch (error) {
      // UI 取消上传按错误 name 识别（feedbackSubmissionJob），abort 必须映射为取消而不是失败。
      if (options?.signal?.aborted === true || (error as Error)?.name === "AbortError") {
        throw new FeedbackUploadCanceledError();
      }
      throw error;
    }
    const envelope = (await response.json()) as FeedbackEnvelope<{
      attachmentId?: unknown;
      size?: unknown;
    }>;
    assertEnvelopeOk(envelope);
    const attachmentId = envelope.data?.attachmentId;
    if (typeof attachmentId !== "string" || !attachmentId) {
      throw new MikikoFeedbackRequestError(response.status, envelope.code, "invalid_upload_response");
    }
    options?.onUploadProgress?.({ uploadedBytes: buffer.byteLength, totalBytes: buffer.byteLength });
    const now = new Date().toISOString();
    return {
      id: 1,
      kind,
      filename,
      size: typeof envelope.data?.size === "number" ? envelope.data.size : buffer.byteLength,
      sha256: null,
      redacted: true,
      content_type: contentType,
      created_at: now,
    };
  }
}

function assertEnvelopeOk(envelope: FeedbackEnvelope<unknown>): void {
  if (typeof envelope.code === "number" && envelope.code !== 0) {
    throw new MikikoFeedbackRequestError(200, envelope.code, envelope.msg || "feedback_error");
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const envelope = (await response.json()) as FeedbackEnvelope<unknown>;
    return envelope.msg || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
