import type {
  CreateFeedbackTicketInput,
  FeedbackAttachment,
  FeedbackAttachmentKind,
  FeedbackComment,
  FeedbackListQuery,
  FeedbackListResult,
  FeedbackTicketDetail,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { Event } from "@zcode/rpc";
import { createServiceDescriptor } from "../descriptors.js";

export interface FeedbackUploadProgress {
  id: string;
  phase: "preparing" | "uploading" | "complete" | "canceled";
  uploadedBytes: number;
  totalBytes: number;
}

export interface FeedbackCreateOptions {
  operationId?: string;
}

export interface IFeedbackService {
  create(
    input: CreateFeedbackTicketInput,
    options?: FeedbackCreateOptions,
  ): Promise<FeedbackTicketDetail>;
  cancelCreate(operationId: string): Promise<void>;
  list(query?: FeedbackListQuery): Promise<FeedbackListResult>;
  get(id: string): Promise<FeedbackTicketDetail>;
  comment(id: string, body: string): Promise<FeedbackComment>;
  /**
   * F.2 账户化：把本地反馈档案（synced + pending-sync）幂等迁移到当前 Mikiko 账号
   * 并清空本地存档。由 node.ts 在 Mikiko ID 登录完成后自动触发。
   */
  syncAccountRecords(): Promise<{ migrated: number }>;
  uploadAttachment(
    id: string,
    kind: FeedbackAttachmentKind,
    file: { path: string; filename?: string; contentType?: string; messageId?: string },
  ): Promise<FeedbackAttachment>;
  uploadAttachmentWithProgress(
    id: string,
    kind: FeedbackAttachmentKind,
    file: { path: string; filename?: string; contentType?: string; messageId?: string },
    progressId: string,
  ): Promise<FeedbackAttachment>;
  cancelUpload(progressId: string): Promise<void>;
  onDynamicUploadProgress(id: string): Event<FeedbackUploadProgress>;
  uploadAttachmentData(
    id: string,
    kind: FeedbackAttachmentKind,
    file: {
      dataBase64: string;
      filename: string;
      contentType: string;
      messageId?: string;
    },
  ): Promise<FeedbackAttachment>;
  attachLogsFromExport(id: string, options?: { full?: boolean }): Promise<FeedbackAttachment>;
  getDeviceSnapshot(): Promise<import("@zcode/shared").FeedbackDeviceInfo>;
  prepareCompactLogArchive(options?: { full?: boolean; progressId?: string }): Promise<{
    path: string;
    size: number;
  }>;
  cleanupPreparedLogArchive(path: string): Promise<void>;
  revealLogArchive(path: string): Promise<void>;
}

export const IFeedbackService = createServiceDescriptor<IFeedbackService>(ServiceChannels.Feedback);
