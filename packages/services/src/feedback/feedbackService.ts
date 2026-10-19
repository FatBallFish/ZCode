import { basename, join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type {
  ApiClient,
  FeedbackDeviceInfo,
  FeedbackTicketStatus,
  FeedbackTicketSummary,
} from "@zcode/shared";
import { MIKIKO_COMMIT, ZCODE_BUILD_TIME, ZCODE_VERSION, resolveMikikoFeedbackApiBase } from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import { arch, platform, release, type as osType } from "node:os";

import type { ICredentialService } from "../credential/credential.js";
import type { IOAuthService } from "../oauth/oauth.js";
import type { FeedbackUploadProgress, IFeedbackService } from "./feedback.js";
import {
  MikikoFeedbackHttpClient,
  MikikoFeedbackRequestError,
  type MikikoMigrateRecord,
  type MikikoRemoteTicket,
} from "./mikikoFeedbackHttpClient.js";
import {
  invalidateAndReacquireMikikoFeedbackDeviceToken,
  resolveMikikoFeedbackDeviceToken,
} from "../conversation-share/mikikoShareDeviceToken.js";
import { cleanupLogArchive, prepareCompactLogArchive } from "./compactLogArchive.js";
import { getFeedbackAttachmentDir } from "../paths.js";
import { FeedbackLocalTicketStore } from "./feedbackLocalTicketStore.js";

/**
 * 本地优先的反馈服务（specs/mikiko-cloud/feedback-tickets.md，2026-10-19 切自建）。
 *
 * - 出网仅 agent.mikiko.ai（resolveMikikoFeedbackApiBase），鉴权为设备 token
 *   （sha256(deviceMid) 注册换取），不再使用智谱 OAuth JWT。
 * - 「我的反馈」一律读本地 tickets.json（换设备不同步，符合当前无统一账号的现状）；
 *   云端工单状态/评论由 mikiko-cloud 管理后台消费。
 * - 云端创建失败时仍写入 pending-sync 本地记录后抛错：用户看到真实失败，
 *   历史记录留待 OAuth 迁移（FeedbackAccountSync 预留）。
 */

export interface CreateFeedbackServiceOptions {
  credentialService: ICredentialService;
  oauthService: IOAuthService;
  apiClient: ApiClient;
  getDeviceMid?: () => string | undefined;
  apiBaseUrl?: string;
  homeDir?: string;
  /** Mikiko ID（KeyCloak）access token 源（F.2）：sub2api 服务的 getOIDCAccessToken 注入。 */
  getMikikoIdAccessToken?: () => Promise<string | null>;
  createFullLogArchive?: (
    sourceDir: string,
    options?: {
      onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
    },
  ) => Promise<{ path: string; size: number }>;
  revealPath?: (path: string) => Promise<void>;
}

/**
 * OAuth 数据同步预留：当前无统一账号体系，空实现占位。未来接入统一 OAuth 后：
 * 1) 上报记录补 userId；2) 实现 syncPendingLocalRecords —— 把本地 pending-sync /
 *    synced 记录按 clientTicketId 对账迁移到远端账号（spec §迁移约定）。
 */
export interface FeedbackAccountSync {
  readonly userId: string | null;
  syncPendingLocalRecords(): Promise<{ migrated: number }>;
}

function noopAccountSync(): FeedbackAccountSync {
  return {
    userId: null,
    async syncPendingLocalRecords() {
      return { migrated: 0 };
    },
  };
}

function buildDeviceSnapshot(): FeedbackDeviceInfo {
  return {
    appVersion: ZCODE_VERSION,
    buildCommitId: MIKIKO_COMMIT,
    buildTime: ZCODE_BUILD_TIME,
    nodeVersion: process.version,
    osType: osType(),
    osPlatform: platform(),
    osRelease: release(),
    // node:os.version() 在 macOS 上是完整 Darwin kernel 字符串，超过后端 os_version VARCHAR(64) 会写库失败。
    osVersion: release(),
    osArch: arch(),
  };
}

export function createFeedbackService(options: CreateFeedbackServiceOptions): IFeedbackService {
  const apiBaseUrl = options.apiBaseUrl?.trim() || resolveMikikoFeedbackApiBase() || "";
  if (!apiBaseUrl) {
    throw new Error("Mikiko feedback API base disabled (MIKIKO_FEEDBACK_API_BASE=disabled)");
  }
  const deviceTokenOptions = {
    apiClient: options.apiClient,
    credentialService: options.credentialService,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  };
  const accountTokenRef: { current: (() => Promise<string | null>) | null } = { current: null };
  const httpClient = new MikikoFeedbackHttpClient({
    baseUrl: apiBaseUrl,
    apiClient: options.apiClient,
    getDeviceToken: () => resolveMikikoFeedbackDeviceToken(deviceTokenOptions),
    reacquireDeviceToken: () => invalidateAndReacquireMikikoFeedbackDeviceToken(deviceTokenOptions),
    getAccountToken: async () => (accountTokenRef.current ? accountTokenRef.current() : null),
  });
  const localTicketStore = new FeedbackLocalTicketStore();
  const getAccountToken = async (): Promise<string | null> => {
    try {
      return (await options.getMikikoIdAccessToken?.()) ?? null;
    } catch {
      return null;
    }
  };
  accountTokenRef.current = getAccountToken;
  let accountUserId: string | null = null;
  const accountSync: FeedbackAccountSync = {
    get userId() {
      return accountUserId;
    },
    async syncPendingLocalRecords() {
      const token = await getAccountToken();
      if (!token) {
        return { migrated: 0 };
      }
      const mid = requireHostDeviceMid();
      const records = await localTicketStore.list(mid, {});
      if (records.length === 0) {
        return { migrated: 0 };
      }
      const payload: MikikoMigrateRecord[] = records.slice(0, 200).map((record) => ({
        // 已同步记录的 id 是远端工单 id，认领按 clientTicketId（服务端 UPDATE 匠配匿名行）；
        // pending-sync 记录从未出网，用确定性 local-<id> 补建。
        clientTicketId: (record as { clientTicketId?: string }).clientTicketId ?? `local-${record.id}`,
        title: record.title,
        description: (record as { description?: string }).description ?? "",
        createdAt: Date.parse(record.created_at) || Date.now(),
      }));
      const result = await httpClient.migrate(payload);
      accountUserId = "mikiko-id";
      // 迁移成功后本地档案整体清除（F.2.2）：查询改走远端，本地不再积累双源记录。
      await localTicketStore.clearAll(mid);
      return { migrated: result.migrated };
    },
  };
  const uploadProgressEmitters = new Map<string, Emitter<FeedbackUploadProgress>>();
  const activeUploadControllers = new Map<string, AbortController>();
  const activeCreateControllers = new Map<string, AbortController>();

  function requireHostDeviceMid(): string {
    const deviceMid = options.getDeviceMid?.()?.trim();
    if (!deviceMid) {
      throw new Error("Missing feedback device_mid");
    }
    return deviceMid;
  }

  function getUploadProgressEmitter(id: string): Emitter<FeedbackUploadProgress> {
    const current = uploadProgressEmitters.get(id);
    if (current) return current;
    const emitter = new Emitter<FeedbackUploadProgress>({
      onDidRemoveLastListener: () => {
        uploadProgressEmitters.delete(id);
        emitter.dispose();
      },
    });
    uploadProgressEmitters.set(id, emitter);
    return emitter;
  }

  /** 云端创建失败时的离线兜底记录：本地 pending-sync，等 OAuth 迁移。 */
  async function upsertPendingSyncRecord(deviceMid: string, title: string, description: string): Promise<string> {
    const now = new Date().toISOString();
    const localId = `local-${randomUUID()}`;
    await localTicketStore.upsert(deviceMid, {
      id: localId,
      title,
      type: "bug",
      status: "已提交",
      created_at: now,
      updated_at: now,
      // 附加字段随 detail 一起序列化进 tickets.json（additive，读取端忽略）。
      description,
      syncState: "pending-sync",
    } as Parameters<typeof localTicketStore.upsert>[1]);
    return localId;
  }

  return {
    create: async (input, createOptions) => {
      const device = input.device ?? buildDeviceSnapshot();
      const operationId = createOptions?.operationId?.trim();
      const controller = new AbortController();
      if (operationId) {
        // UI 取消创建工单时不能只关闭弹窗；host 需要能按 operationId
        // 找到当前 HTTP 请求并 abort，避免“正在连接反馈服务”永久悬挂。
        activeCreateControllers.get(operationId)?.abort();
        activeCreateControllers.set(operationId, controller);
      }
      try {
        let ticket: Awaited<ReturnType<typeof httpClient.create>>;
        // clientTicketId（F.2）：远端行携带后，账号迁移可按 (owner, clientTicketId) 认领。
        const clientTicketId = `local-${randomUUID()}`;
        try {
          ticket = await httpClient.create({ ...input, device }, {
            signal: controller.signal,
            clientTicketId,
          });
        } catch (error) {
          // 本地优先：云端失败仍留档（pending-sync），用户看到真实错误，历史可迁移。
          if (!(error instanceof MikikoFeedbackRequestError) || error.status >= 500 || error.status === 0) {
            await upsertPendingSyncRecord(
              requireHostDeviceMid(),
              input.title,
              input.description,
            ).catch(() => {});
          }
          throw error;
        }
        // 成功同样无条件落本地：synced 标记 + description + clientTicketId 供认领对账。
        await localTicketStore.upsert(requireHostDeviceMid(), {
          ...ticket,
          clientTicketId,
          syncState: "synced",
        } as Parameters<typeof localTicketStore.upsert>[1]);
        return ticket;
      } finally {
        if (operationId && activeCreateControllers.get(operationId) === controller) {
          activeCreateControllers.delete(operationId);
        }
      }
    },
    cancelCreate: async (operationId) => {
      const key = operationId.trim();
      if (!key) return;
      activeCreateControllers.get(key)?.abort();
    },
    list: async (query) => {
      // F.2 账户化：登录态「我的反馈」读远端（换设备可见）；未登录/远端失败回落本地。
      if (await getAccountToken()) {
        try {
          // 一次取大页后本地过滤/分页：本地状态文案与远端机器码不同构，直接透传过滤会错配。
          const mine = await httpClient.listMine({ page: 1, pageSize: 100 });
          const mapped = mine.items.map(remoteTicketToLocalSummary).filter((item) => {
            if (query?.status && item.status !== query.status) return false;
            if (query?.type && item.type !== query.type) return false;
            return true;
          });
          const offset = Math.max(0, query?.offset ?? 0);
          const limit = query?.limit !== undefined && query.limit >= 0 ? query.limit : mapped.length;
          return { items: mapped.slice(offset, offset + limit), total: mapped.length };
        } catch {
          // 远端不可用不阻断列表：回落本地档案（可能为空）。
        }
      }
      const items = await localTicketStore.list(requireHostDeviceMid(), query);
      return { items, total: items.length };
    },
    get: async (id) => {
      const summary = await localTicketStore.get(requireHostDeviceMid(), id);
      if (!summary) {
        throw new Error(`Feedback ticket not found locally: ${id}`);
      }
      return {
        ...summary,
        description: (summary as { description?: string }).description ?? "",
        attachments: [],
        comments: [],
        events: [],
      };
    },
    comment: async (ticketId, body) => {
      // F.2：账号登录态开放本人评论；未登录维持不支持（本地记录模式）。
      if (!(await getAccountToken())) {
        throw new Error("Feedback comment requires Mikiko ID sign-in");
      }
      const added = await httpClient.addOwnComment(ticketId, body);
      const now = new Date().toISOString();
      return {
        id: Date.now(),
        message_id: added.commentId,
        body,
        is_staff: false,
        created_at: now,
      };
    },
    uploadAttachment: async (id, kind, file) => {
      const filename = file.filename ?? basename(file.path);
      const contentType = file.contentType ?? (kind === "image" ? "image/png" : "application/zip");
      return httpClient.uploadFile(id, kind, file.path, filename, contentType, {
        signal: undefined,
      });
    },
    uploadAttachmentWithProgress: async (id, kind, file, progressId) => {
      const filename = file.filename ?? basename(file.path);
      const contentType = file.contentType ?? (kind === "image" ? "image/png" : "application/zip");
      const emitter = getUploadProgressEmitter(progressId);
      emitter.fire({
        id: progressId,
        phase: "preparing",
        uploadedBytes: 0,
        totalBytes: 0,
      });
      const controller = new AbortController();
      activeUploadControllers.set(progressId, controller);
      return httpClient
        .uploadFile(id, kind, file.path, filename, contentType, {
          signal: controller.signal,
          onUploadProgress: (event) => {
            emitter.fire({
              id: progressId,
              phase: event.uploadedBytes >= event.totalBytes ? "complete" : "uploading",
              uploadedBytes: event.uploadedBytes,
              totalBytes: event.totalBytes,
            });
          },
        })
        .finally(() => {
          activeUploadControllers.delete(progressId);
        });
    },
    cancelUpload: async (progressId) => {
      activeUploadControllers.get(progressId)?.abort();
    },
    onDynamicUploadProgress: (id) => getUploadProgressEmitter(id).event,
    uploadAttachmentData: async (id, kind, file) => {
      const attachmentRootDir = getFeedbackAttachmentDir();
      await mkdir(attachmentRootDir, { recursive: true });
      const tempDir = await mkdtemp(join(attachmentRootDir, "attachment-"));
      // 附件名来自 renderer，不能作为本地相对路径使用。
      const filename = basename(file.filename.replaceAll("\\", "/")) || "attachment";
      const tempPath = join(tempDir, "content");
      try {
        await writeFile(tempPath, Buffer.from(file.dataBase64, "base64"));
        return await httpClient.uploadFile(id, kind, tempPath, filename, file.contentType, {
          signal: undefined,
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    attachLogsFromExport: async (id, attachOptions) => {
      const archive = await prepareCompactLogArchive({
        full: attachOptions?.full,
        createFullArchive: options.createFullLogArchive,
      });
      try {
        return await httpClient.uploadFile(
          id,
          "log",
          archive.path,
          basename(archive.path),
          "application/zip",
        );
      } finally {
        await cleanupLogArchive(archive.path);
      }
    },
    syncAccountRecords: async () => accountSync.syncPendingLocalRecords(),
    getDeviceSnapshot: async () => buildDeviceSnapshot(),
    prepareCompactLogArchive: async (archiveOptions) => {
      const progressId = archiveOptions?.progressId;
      const progressEmitter = progressId ? getUploadProgressEmitter(progressId) : null;
      return prepareCompactLogArchive({
        full: archiveOptions?.full,
        createFullArchive: options.createFullLogArchive,
        onProgress: progressEmitter
          ? (event) => {
              progressEmitter.fire({
                id: progressId!,
                phase: "preparing",
                uploadedBytes: event.processedBytes,
                totalBytes: event.totalBytes,
              });
            }
          : undefined,
      });
    },
    cleanupPreparedLogArchive: (path) => cleanupLogArchive(path),
    revealLogArchive: async (path) => {
      if (options.revealPath) {
        await options.revealPath(path);
        return;
      }
    },
  };
}

/**
 * 远端工单状态（机器码）→ 本地展示闭集（FeedbackTicketStatus）。口径对齐管理后台
 * 跟进语义：待定位/定位中/已定位/待出包 都还在处理链上 → 开发中。
 */
const REMOTE_STATUS_LABELS: Record<string, FeedbackTicketStatus> = {
  pending_triage: "已提交",
  triaging: "开发中",
  located: "开发中",
  not_issue: "已拒绝",
  awaiting_release: "开发中",
  resolved: "已解决",
};

function remoteTicketToLocalSummary(ticket: MikikoRemoteTicket): FeedbackTicketSummary {
  const mapped = REMOTE_STATUS_LABELS[ticket.status];
  return {
    id: ticket.id,
    title: ticket.title,
    type: ticket.kind === "feature" ? "feature" : "bug",
    status: mapped ?? "已提交",
    created_at: new Date(ticket.createdAt).toISOString(),
    updated_at: new Date(ticket.updatedAt).toISOString(),
  };
}

/** 暴露给 OAuth 接入点的同步器构造口（node.ts 在 Mikiko ID 登录后调用）。 */
export function createFeedbackAccountSync(): FeedbackAccountSync {
  return noopAccountSync();
}
