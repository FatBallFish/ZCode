import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import worker from "../src/worker.ts";
import { createMemoryD1, createMemoryKv, createMemoryR2 } from "./helpers.ts";

/**
 * Bug 上报 + 工单管理端到端测试（specs/mikiko-cloud/feedback-tickets.md）。
 * 走 worker.fetch 全路由（含鉴权门禁）；D1 用 node:sqlite 内存 shim 跑真 SQL。
 */

const MIGRATION_SQL = readFileSync(
  join(import.meta.dirname, "..", "migrations", "0001-feedback-init.sql"),
  "utf-8",
);

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "correct-horse";
const ADMIN_SESSION_SECRET = "test-session-secret-32-bytes-xxxxxxxx";

interface TestEnv {
  ASSETS: unknown;
  MIKIKO_BUILTIN_CONFIG: ReturnType<typeof createMemoryKv>;
  MIKIKO_CLIENT_CONFIG: ReturnType<typeof createMemoryKv>;
  MIKIKO_SHARE: ReturnType<typeof createMemoryKv>;
  SHARE_ARTIFACTS: ReturnType<typeof createMemoryR2>;
  DB: ReturnType<typeof createMemoryD1>;
  FEEDBACK_ARTIFACTS: ReturnType<typeof createMemoryR2>;
  MIKIKO_ADMIN_USERNAME: string;
  MIKIKO_ADMIN_PASSWORD: string;
  MIKIKO_ADMIN_SESSION_SECRET: string;
}

function createEnv(): TestEnv {
  return {
    ASSETS: undefined,
    MIKIKO_BUILTIN_CONFIG: createMemoryKv(),
    MIKIKO_CLIENT_CONFIG: createMemoryKv(),
    MIKIKO_SHARE: createMemoryKv(),
    SHARE_ARTIFACTS: createMemoryR2(),
    DB: createMemoryD1(MIGRATION_SQL),
    FEEDBACK_ARTIFACTS: createMemoryR2(),
    MIKIKO_ADMIN_USERNAME: ADMIN_USERNAME,
    MIKIKO_ADMIN_PASSWORD: ADMIN_PASSWORD,
    MIKIKO_ADMIN_SESSION_SECRET: ADMIN_SESSION_SECRET,
  };
}

function call(env: TestEnv, path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://agent.mikiko.ai${path}`, init), env as never) as Promise<Response>;
}

/** 通过 shares 的注册端点取设备 token（feedback 复用同一设备身份体系）。 */
async function registerDeviceToken(env: TestEnv): Promise<string> {
  // 设备 id 需为 16~128 位 hex（sha256(deviceMid) 形态）。
  const deviceId = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const response = await call(env, "/api/v1/shares/device/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: { device_token: string } };
  return body.data.device_token;
}

async function loginAdmin(env: TestEnv): Promise<string> {
  const response = await call(env, "/api/v1/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie") ?? "";
  return cookie.split(";")[0]!;
}

async function createTicket(env: TestEnv, token: string, title = "暗色主题文字看不清"): Promise<string> {
  const response = await call(env, "/api/v1/feedback/tickets", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      clientTicketId: "local-1",
      title,
      description: `复现：${title}`,
      contact: "user@example.com",
      environment: { appVersion: "1.1.2", platform: "darwin-aarch64" },
      appVersion: "1.1.2",
      platform: "darwin-aarch64",
      locale: "zh-CN",
    }),
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { data: { ticketId: string; status: string } };
  assert.equal(body.data.status, "pending_triage");
  return body.data.ticketId;
}

describe("feedback 客户端端点", () => {
  it("无设备 token 创建被拒（401）", async () => {
    const env = createEnv();
    const response = await call(env, "/api/v1/feedback/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t", description: "d" }),
    });
    assert.equal(response.status, 401);
  });

  it("创建工单默认 pending_triage，附件经 R2 中转落库", async () => {
    const env = createEnv();
    const token = await registerDeviceToken(env);
    const ticketId = await createTicket(env, token);

    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
    const upload = await call(env, `/api/v1/feedback/tickets/${ticketId}/attachments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/zip",
        "x-attachment-kind": "log",
        "x-file-name": "mikiko-diagnostic-logs.zip",
      },
      body: zipBytes,
    });
    assert.equal(upload.status, 201);
    const uploadBody = (await upload.json()) as { data: { attachmentId: string; size: number } };
    assert.equal(uploadBody.data.size, zipBytes.byteLength);

    // 管理端可见工单与附件。
    const cookie = await loginAdmin(env);
    const detail = await call(env, `/api/v1/admin/feedback/tickets/${ticketId}`, {
      headers: { cookie },
    });
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()) as {
      data: {
        ticket: { status: string; attachmentCount: number };
        attachments: Array<{ fileName: string; kind: string }>;
      };
    };
    assert.equal(detailBody.data.ticket.status, "pending_triage");
    assert.equal(detailBody.data.ticket.attachmentCount, 1);
    assert.equal(detailBody.data.attachments[0]!.fileName, "mikiko-diagnostic-logs.zip");

    // 附件可下载且字节一致。
    const download = await call(
      env,
      `/api/v1/admin/feedback/tickets/${ticketId}/attachments/${uploadBody.data.attachmentId}`,
      { headers: { cookie } },
    );
    assert.equal(download.status, 200);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), zipBytes);
  });

  it("不支持的附件类型被拒", async () => {
    const env = createEnv();
    const token = await registerDeviceToken(env);
    const ticketId = await createTicket(env, token);
    const upload = await call(env, `/api/v1/feedback/tickets/${ticketId}/attachments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "x-attachment-kind": "log",
      },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(upload.status, 400);
  });
});

describe("feedback 管理端点", () => {
  it("未登录访问管理端点被拒（401）", async () => {
    const env = createEnv();
    const response = await call(env, "/api/v1/admin/feedback/tickets");
    assert.equal(response.status, 401);
  });

  it("列表过滤 + 状态/类型/修复版本/跟进人更新 + 评论增改删", async () => {
    const env = createEnv();
    const token = await registerDeviceToken(env);
    const ticketId = await createTicket(env, token);
    await createTicket(env, token, "打开设置页白屏");
    const cookie = await loginAdmin(env);

    // 列表：全部 2 条。
    const listAll = (await (
      (await call(env, "/api/v1/admin/feedback/tickets", { headers: { cookie } })).json()
    ) as { data: { total: number } }).data;
    assert.equal(listAll.total, 2);

    // 关键词过滤。
    const listFiltered = (await (
      (
        await call(env, "/api/v1/admin/feedback/tickets?q=暗色", { headers: { cookie } })
      ).json()
    ) as { data: { total: number } }).data;
    assert.equal(listFiltered.total, 1);

    // PATCH：状态/类型/修复版本/跟进人。
    const patch = await call(env, `/api/v1/admin/feedback/tickets/${ticketId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        status: "located",
        type: "legacy_bug",
        fixVersion: "1.1.3",
        assignee: "fatballfish",
      }),
    });
    assert.equal(patch.status, 200);
    const patchBody = (await patch.json()) as {
      data: { ticket: { status: string; type: string; fixVersion: string; assignee: string } };
    };
    assert.equal(patchBody.data.ticket.status, "located");
    assert.equal(patchBody.data.ticket.type, "legacy_bug");
    assert.equal(patchBody.data.ticket.fixVersion, "1.1.3");
    assert.equal(patchBody.data.ticket.assignee, "fatballfish");

    // 状态过滤：located 1 条、pending_triage 1 条。
    const listLocated = (await (
      (
        await call(env, "/api/v1/admin/feedback/tickets?status=located", { headers: { cookie } })
      ).json()
    ) as { data: { total: number } }).data;
    assert.equal(listLocated.total, 1);

    // 非法状态被拒。
    const badPatch = await call(env, `/api/v1/admin/feedback/tickets/${ticketId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ status: "not_a_status" }),
    });
    assert.equal(badPatch.status, 400);

    // 评论：创建 → 编辑 → 删除。
    const comment = await call(env, `/api/v1/admin/feedback/tickets/${ticketId}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ author: "fatballfish", body: "根因：token 不存在，Tailwind 未生成类" }),
    });
    assert.equal(comment.status, 201);
    const commentId = ((await comment.json()) as { data: { commentId: string } }).data.commentId;

    const edited = await call(
      env,
      `/api/v1/admin/feedback/tickets/${ticketId}/comments/${commentId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ body: "修复方案：替换为 bg-popover（v1.1.3 出包）" }),
      },
    );
    assert.equal(edited.status, 200);
    const editedBody = (await edited.json()) as { data: { comment: { body: string } } };
    assert.match(editedBody.data.comment.body, /bg-popover/);

    const removed = await call(
      env,
      `/api/v1/admin/feedback/tickets/${ticketId}/comments/${commentId}`,
      { method: "DELETE", headers: { cookie } },
    );
    assert.equal(removed.status, 200);

    const detail = (await (
      await call(env, `/api/v1/admin/feedback/tickets/${ticketId}`, { headers: { cookie } })
    ).json()) as { data: { comments: unknown[] } };
    assert.equal(detail.data.comments.length, 0);
  });
});
