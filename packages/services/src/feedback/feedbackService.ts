import { basename, join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { ApiClient, FeedbackDeviceInfo } from "@zcode/shared";
import { MIKIKO_COMMIT, ZCODE_BUILD_TIME, ZCODE_VERSION, resolveMikikoFeedbackApiBase } from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import { arch, platform, release, type as osType } from "node:os";

import type { ICredentialService } from "../credential/credential.js";
import type { IOAuthService } from "../oauth/oauth.js";
import type { FeedbackUploadProgress, IFeedbackService } from "./feedback.js";
import {
  MikikoFeedbackHttpClient,
  MikikoFeedbackRequestError,
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
  const httpClient = new MikikoFeedbackHttpClient({
    baseUrl: apiBaseUrl,
    apiClient: options.apiClient,
    getDeviceToken: () => resolveMikikoFeedbackDeviceToken(deviceTokenOptions),
    reacquireDeviceToken: () => invalidateAndReacquireMikikoFeedbackDeviceToken(deviceTokenOptions),
  });
  const localTicketStore = new FeedbackLocalTicketStore();
  const accountSync = noopAccountSync();
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
        try {
          ticket = await httpClient.create({ ...input, device }, { signal: controller.signal });
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
        // 成功同样无条件落本地：synced 标记 + description 供本地详情展示。
        await localTicketStore.upsert(requireHostDeviceMid(), {
          ...ticket,
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
      // 本地优先：一律读本地（云端状态/类型分类由管理后台维护，不回读）。
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
    comment: async () => {
      // 本地记录模式不支持追加评论；接入统一 OAuth 后由 FeedbackAccountSync 打开。
      throw new Error("Feedback comment requires account sync (not yet available)");
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

/** 暴露给未来 OAuth 接入点的同步器构造口（当前为空实现）。 */
export function createFeedbackAccountSync(): FeedbackAccountSync {
  return noopAccountSync();
}
