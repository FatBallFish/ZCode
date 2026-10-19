import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ApiRequestInit } from "@zcode/shared";
import { createFeedbackService } from "../src/feedback/feedbackService.js";
import { setDataBaseDir } from "../src/paths.js";
import type { ICredentialService } from "../src/credential/credential.js";
import type { IOAuthService } from "../src/oauth/oauth.js";

/** F.2 反馈账户化（客户端）：账号通道、远端列表、登录后迁移与清档。 */

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function createHarness(options?: { accountToken?: string | null }) {
  const requests: CapturedRequest[] = [];
  const request = vi.fn(async (url: string | URL | Request, init?: ApiRequestInit) => {
    const captured: CapturedRequest = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    };
    requests.push(captured);
    if (captured.url.includes("/shares/device/register")) {
      // 注册协议：body {deviceId}，响应信封 data.device_token。
      return new Response(JSON.stringify({ code: 0, data: { device_token: "dev-token" } }));
    }
    if (captured.url.endsWith("/feedback/tickets")) {
      return new Response(
        JSON.stringify({ code: 0, data: { ticketId: "fb_remote_1", status: "pending_triage" } }),
      );
    }
    if (captured.url.includes("/feedback/tickets/mine")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            total: 1,
            items: [
              {
                id: "fb_remote_1",
                clientTicketId: null,
                kind: "bug",
                ownerEmail: "u@mikiko.ai",
                title: "远端标题",
                description: "d",
                contact: null,
                status: "resolved",
                type: null,
                fixVersion: null,
                assignee: null,
                attachmentCount: 0,
                createdAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_000,
              },
            ],
          },
        }),
      );
    }
    if (captured.url.includes("/feedback/tickets/migrate")) {
      return new Response(JSON.stringify({ code: 0, data: { migrated: 1, skipped: 0 } }));
    }
    if (captured.url.includes("/comments")) {
      return new Response(JSON.stringify({ code: 0, data: { commentId: "fc_1" } }));
    }
    return new Response(JSON.stringify({ code: 0, data: {} }));
  });
  const credentialService: ICredentialService = {
    load: async () => null,
    save: async () => {},
    delete: async () => {},
  };
  const service = createFeedbackService({
    apiClient: { request },
    credentialService,
    oauthService: {} as unknown as IOAuthService,
    getDeviceMid: () => "mid-account-test",
    apiBaseUrl: "https://agent.mikiko.invalid/api/v1",
    // homeDir 隔离：设备注册的 ensureTelemetryDeviceMid 不落真实 HOME。
    ...(options?.homeDir ? { homeDir: options.homeDir } : {}),
    getMikikoIdAccessToken: async () => options?.accountToken ?? null,
  });
  return { service, requests, request, credentialService };
}

const deviceInput = {
  title: "t",
  description: "d",
  type: "bug" as const,
  severity: "P2-中" as never,
  module: "其它" as never,
};

describe("反馈账户化（客户端）", () => {
  it("未登录 create 走设备 token 且带 kind=bug 与 clientTicketId；不落账号头", async () => {
    const base = await mkdtemp(join(tmpdir(), "fb-anon-"));
    setDataBaseDir(base);
    try {
      const { service, requests } = createHarness({ homeDir: base });
      await service.create(deviceInput);
      const create = requests.find((entry) => entry.url.endsWith("/feedback/tickets"));
      expect(create).toBeDefined();
      expect(create?.headers.authorization).toBe("Bearer dev-token");
      const body = JSON.parse(create?.body ?? "{}") as Record<string, unknown>;
      expect(body.kind).toBe("bug");
      expect(String(body.clientTicketId)).toMatch(/^local-/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("登录态 create 用 Mikiko ID Bearer；feature 类型传 kind=feature", async () => {
    const base = await mkdtemp(join(tmpdir(), "fb-acct-"));
    setDataBaseDir(base);
    try {
      const { service, requests } = createHarness({ accountToken: "oidc-at", homeDir: base });
      await service.create({ ...deviceInput, type: "feature" });
      const create = requests.find((entry) => entry.url.endsWith("/feedback/tickets"));
      expect(create?.headers.authorization).toBe("Bearer oidc-at");
      const body = JSON.parse(create?.body ?? "{}") as Record<string, unknown>;
      expect(body.kind).toBe("feature");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("登录态 list 走远端 mine 并映射状态闭集；未登录回落本地（空）", async () => {
    const base = await mkdtemp(join(tmpdir(), "fb-list-"));
    setDataBaseDir(base);
    try {
      const online = createHarness({ accountToken: "oidc-at", homeDir: base });
      const remote = await online.service.list({});
      expect(remote.total).toBe(1);
      expect(remote.items[0]?.title).toBe("远端标题");
      expect(remote.items[0]?.status).toBe("已解决");
      expect(online.requests.some((entry) => entry.url.includes("/feedback/tickets/mine"))).toBe(true);

      const offline = createHarness({ homeDir: base });
      const local = await offline.service.list({});
      expect(local.total).toBe(0);
      expect(
        offline.requests.some((entry) => entry.url.includes("/feedback/tickets/mine")),
      ).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("syncAccountRecords：迁移本地 pending-sync 记录并整体清档；未登录为 no-op", async () => {
    const base = await mkdtemp(join(tmpdir(), "fb-sync-"));
    setDataBaseDir(base);
    try {
      // 先离线制造一条 pending-sync：创建接口 500 时本地留档。
      const harness = createHarness({ homeDir: base });
      harness.request.mockImplementationOnce(async (url: string | URL | Request) =>
        String(url).endsWith("/feedback/tickets")
          ? new Response("server boom", { status: 500 })
          : new Response(JSON.stringify({ code: 0, data: {} })),
      );
      await expect(harness.service.create(deviceInput)).rejects.toThrow();
      const storePath = join(base, ".mikiko", "feedback", "tickets.json");
      const before = JSON.parse(await readFile(storePath, "utf8")) as { tickets: unknown[] };
      expect(before.tickets.length).toBe(1);

      // 未登录：no-op 不出网。
      const idle = await harness.service.syncAccountRecords();
      expect(idle.migrated).toBe(0);

      // 登录后：迁移成功并清空本地档案（同 base，读同一份 tickets.json）。
      const onlineHarness = createHarness({ accountToken: "oidc-at", homeDir: base });
      const result = await onlineHarness.service.syncAccountRecords();
      expect(result.migrated).toBe(1);
      const migrateCall = onlineHarness.requests.find((entry) =>
        entry.url.includes("/feedback/tickets/migrate"),
      );
      const payload = JSON.parse(migrateCall?.body ?? "{}") as {
        records: Array<{ clientTicketId: string; title: string }>;
      };
      expect(payload.records.length).toBe(1);
      expect(payload.records[0]?.title).toBe("t");
      const after = JSON.parse(await readFile(storePath, "utf8")) as { tickets: unknown[] };
      expect(after.tickets.length).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("comment：未登录抛错；登录态走账号评论端点", async () => {
    const base = await mkdtemp(join(tmpdir(), "fb-comment-"));
    setDataBaseDir(base);
    try {
      const offline = createHarness({ homeDir: base });
      await expect(offline.service.comment("fb_x", "hi")).rejects.toThrow(/Mikiko ID/);

      const online = createHarness({ accountToken: "oidc-at", homeDir: base });
      const comment = await online.service.comment("fb_x", "补充信息");
      expect(comment.message_id).toBe("fc_1");
      expect(
        online.requests.some(
          (entry) => entry.url.includes("/fb_x/comments") && entry.headers.authorization === "Bearer oidc-at",
        ),
      ).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
