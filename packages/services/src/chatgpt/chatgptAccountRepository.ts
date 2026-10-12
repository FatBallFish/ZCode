import { z } from "zod";
import type { ChatGPTAccountRecord } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";

/**
 * ChatGPT 账号仓储：整表存于加密 credentials.json 单键，进程内串行化全部
 * 读-改-写（单一 owner，避免 RT 轮换竞态与并发覆盖）。
 */

const STORAGE_KEY = "chatgpt-accounts";

const isoStringSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: "invalid ISO datetime",
});

const accountRecordSchema = z
  .object({
    accountId: z.string().min(1),
    email: z.string(),
    displayName: z.string().optional(),
    avatarUrl: z.string().optional(),
    createdAt: isoStringSchema,
    updatedAt: isoStringSchema,
    credentials: z
      .object({
        accessToken: z.string().min(1),
        refreshToken: z.string().min(1),
        accessTokenExpiresAt: isoStringSchema.optional(),
        lastRefreshAt: isoStringSchema,
        clientId: z.string().min(1),
      })
      .strict(),
    permanentRefreshFailure: z.object({ reason: z.string(), at: z.number() }).strict().optional(),
    profile: z
      .object({
        planType: z.string().optional(),
        planExpiresAt: isoStringSchema.optional(),
        isDefault: z.boolean().optional(),
        isFedramp: z.boolean(),
      })
      .strict(),
    usage: z.unknown().optional(),
    resetCredits: z
      .object({
        availableCount: z.number(),
        credits: z
          .array(
            z
              .object({
                id: z.string().optional(),
                expiresAt: isoStringSchema.optional(),
                status: z.string().optional(),
              })
              .strict(),
          )
          .readonly(),
      })
      .strict()
      .optional(),
    models: z
      .object({
        slugs: z.array(z.string()).readonly(),
        etag: z.string().optional(),
        updatedAt: isoStringSchema,
      })
      .strict()
      .optional(),
    status: z
      .object({
        state: z.enum(["active", "auth-error"]),
        reason: z.string().optional(),
        updatedAt: z.number(),
      })
      .strict(),
  })
  .strict();

export interface ChatGPTAccountRepository {
  list(): Promise<ChatGPTAccountRecord[]>;
  get(accountId: string): Promise<ChatGPTAccountRecord | null>;
  upsert(record: ChatGPTAccountRecord): Promise<void>;
  /** 串行读-改-写；mutate 返回 null 表示记录不存在或未变更（不写盘）。 */
  update(
    accountId: string,
    mutate: (record: ChatGPTAccountRecord) => ChatGPTAccountRecord | null,
  ): Promise<ChatGPTAccountRecord | null>;
  delete(accountId: string): Promise<boolean>;
}

export function createChatGPTAccountRepository(dependencies: {
  credentialService: ICredentialService;
  now?: () => number;
}): ChatGPTAccountRepository {
  let cache: ChatGPTAccountRecord[] | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = chain.then(operation, operation);
    chain = next.catch(() => undefined);
    return next;
  }

  async function load(): Promise<ChatGPTAccountRecord[]> {
    if (cache) return cache;
    const raw = await dependencies.credentialService.load(STORAGE_KEY);
    if (!raw?.trim()) {
      cache = [];
      return cache;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 损坏数据整体丢弃并保留原值备份语义由 credentialService 层负责；此处 fail-safe 置空。
      cache = [];
      return cache;
    }
    const records: ChatGPTAccountRecord[] = [];
    for (const entry of Array.isArray(parsed) ? parsed : []) {
      const result = accountRecordSchema.safeParse(entry);
      if (result.success) records.push(result.data as ChatGPTAccountRecord);
    }
    cache = records.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return cache;
  }

  async function persist(next: ChatGPTAccountRecord[]): Promise<void> {
    // 先更新内存再落盘：落盘失败时内存与磁盘短暂不一致，但下一次写会覆盖；
    // 凭据写入失败不能丢掉已刷新的 RT（官方 persist_tokens 语义优先保新值）。
    cache = next;
    await dependencies.credentialService.save(STORAGE_KEY, JSON.stringify(next));
  }

  return {
    list: () => serialize(load),
    get: (accountId) =>
      serialize(
        async () => (await load()).find((record) => record.accountId === accountId) ?? null,
      ),
    upsert: (record) =>
      serialize(async () => {
        const records = await load();
        const index = records.findIndex((entry) => entry.accountId === record.accountId);
        if (index >= 0) records.splice(index, 1, record);
        else records.push(record);
        await persist(sortByCreatedAt(records));
      }),
    update: (accountId, mutate) =>
      serialize(async () => {
        const records = await load();
        const index = records.findIndex((entry) => entry.accountId === accountId);
        if (index < 0) return null;
        const next = mutate(records[index]!);
        if (!next) return records[index]!;
        records.splice(index, 1, next);
        await persist(sortByCreatedAt(records));
        return next;
      }),
    delete: (accountId) =>
      serialize(async () => {
        const records = await load();
        const index = records.findIndex((entry) => entry.accountId === accountId);
        if (index < 0) return false;
        records.splice(index, 1);
        await persist(records);
        return true;
      }),
  };
}

function sortByCreatedAt(records: ChatGPTAccountRecord[]): ChatGPTAccountRecord[] {
  return [...records].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
