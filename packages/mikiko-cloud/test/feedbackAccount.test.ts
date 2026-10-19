import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { webcrypto } from "node:crypto";
import { describe, it } from "node:test";
import worker from "../src/worker.ts";
import { __setJwksForTests } from "../src/oidcTokenVerify.ts";
import { createMemoryD1, createMemoryKv, createMemoryR2 } from "./helpers.ts";

/**
 * 反馈账户化端到端（docs/mikiko-id-integration-plan.md F.2 + D.4/D.5）：
 * Mikiko ID Bearer 创建/查询/评论/迁移 + kind + admin DELETE/inline 预览/logout。
 * OIDC 验签走注入 JWKS（本地 RSA 签名 token），不经网络。
 */

const MIGRATION_SQL = [
  "0001-feedback-init.sql",
  "0002-feedback-account.sql",
]
  .map((name) => readFileSync(join(import.meta.dirname, "..", "migrations", name), "utf-8"))
  .join("\n");

const OIDC_ISSUER = "https://id.test/realm";
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
  MIKIKO_OIDC_ISSUER: string;
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
    MIKIKO_OIDC_ISSUER: OIDC_ISSUER,
  };
}

function call(env: TestEnv, path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://agent.mikiko.ai${path}`, init), env as never) as Promise<Response>;
}

async function registerDeviceToken(env: TestEnv): Promise<string> {
  const deviceId = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const response = await call(env, "/api/v1/shares/device/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceMid: deviceId }),
  });
  const body = (await response.json()) as { data?: { token?: string } };
  return body.data?.token ?? "";
}

// ── 本地 RSA 签名 token（JWKS 注入，绕过网络）──
const rsaKeyPair = await webcrypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = await webcrypto.subtle.exportKey("jwk", rsaKeyPair.publicKey);
__setJwksForTests(OIDC_ISSUER, [{ ...publicJwk, kid: "test-key", use: "sig" }]);

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function signOidcToken(claims: Record<string, unknown>): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: "test-key" };
  const payload = { iss: OIDC_ISSUER, azp: "mikiko_code", exp: Math.floor(Date.now() / 1000) + 300, ...claims };
  const signingInput = `${base64Url(new TextEncoder().encode(JSON.stringify(header)))}.${base64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  )}`;
  const signature = await webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    rsaKeyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

const USER_A_TOKEN = await signOidcToken({ sub: "user-a", email: "a@mikiko.ai" });
const USER_B_TOKEN = await signOidcToken({ sub: "user-b", email: "b@mikiko.ai" });

async function adminLogin(env: TestEnv): Promise<string> {
  const response = await call(env, "/api/v1/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function createTicket(env: TestEnv, init: RequestInit): Promise<{ ticketId: string }> {
  const response = await call(env, "/api/v1/feedback/tickets", { method: "POST", ...init });
  const body = (await response.json()) as { data?: { ticketId?: string } };
  return { ticketId: body.data?.ticketId ?? "" };
}

describe("反馈账户化（Mikiko ID Bearer）", () => {
  it("FB-ACC-01 Bearer 创建挂 owner + kind；坏签名 fail-close 不落单", async () => {
    const env = createEnv();
    const created = await createTicket(env, {
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_A_TOKEN}` },
      body: JSON.stringify({ title: "t", description: "d", kind: "feature" }),
    });
    assert.ok(created.ticketId);

    // 篡改签名 → 401 且不创建工单。
    const forged = `${USER_A_TOKEN.slice(0, -6)}AAAAAA`;
    const rejected = await call(env, "/api/v1/feedback/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${forged}` },
      body: JSON.stringify({ title: "bad", description: "d" }),
    });
    assert.equal(rejected.status, 401);
    const cookie = await adminLogin(env);
    const list = await call(env, "/api/v1/admin/feedback/tickets", { headers: { cookie } });
    const body = (await list.json()) as { data?: { items?: Array<{ id: string; kind: string; ownerEmail: string | null }> } };
    assert.equal(body.data?.items?.length, 1);
    assert.equal(body.data?.items?.[0]?.kind, "feature");
    assert.equal(body.data?.items?.[0]?.ownerEmail, "a@mikiko.ai");
  });

  it("FB-ACC-02 mine 只见本人工单；他人工单详情/评论 403", async () => {
    const env = createEnv();
    const a = await createTicket(env, {
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_A_TOKEN}` },
      body: JSON.stringify({ title: "mine", description: "d" }),
    });
    const deviceToken = await registerDeviceToken(env);
    await createTicket(env, {
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ title: "anon", description: "d" }),
    });
    await createTicket(env, {
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_B_TOKEN}` },
      body: JSON.stringify({ title: "other", description: "d" }),
    });

    const mine = await call(env, "/api/v1/feedback/tickets/mine", {
      headers: { authorization: `Bearer ${USER_A_TOKEN}` },
    });
    const mineBody = (await mine.json()) as { data?: { items?: Array<{ title: string }>; total?: number } };
    assert.equal(mineBody.data?.total, 1);
    assert.equal(mineBody.data?.items?.[0]?.title, "mine");

    const detail = await call(env, `/api/v1/feedback/tickets/${a.ticketId}`, {
      headers: { authorization: `Bearer ${USER_B_TOKEN}` },
    });
    assert.equal(detail.status, 403);
    const comment = await call(env, `/api/v1/feedback/tickets/${a.ticketId}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_B_TOKEN}` },
      body: JSON.stringify({ body: "hi" }),
    });
    assert.equal(comment.status, 403);
  });

  it("FB-ACC-03 本人评论成功并更新工单 updated_at", async () => {
    const env = createEnv();
    const a = await createTicket(env, {
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_A_TOKEN}` },
      body: JSON.stringify({ title: "c", description: "d" }),
    });
    const commented = await call(env, `/api/v1/feedback/tickets/${a.ticketId}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_A_TOKEN}` },
      body: JSON.stringify({ body: "补充复现步骤" }),
    });
    assert.equal(commented.status, 201);
    const detail = await call(env, `/api/v1/feedback/tickets/${a.ticketId}`, {
      headers: { authorization: `Bearer ${USER_A_TOKEN}` },
    });
    const body = (await detail.json()) as { data?: { comments?: Array<{ body: string }> } };
    assert.equal(body.data?.comments?.length, 1);
    assert.equal(body.data?.comments?.[0]?.body, "补充复现步骤");
  });

  it("FB-ACC-04 migrate 幂等：二次全 skip，保留原 created_at，坏记录跳过", async () => {
    const env = createEnv();
    const records = [
      { clientTicketId: "local-1", title: "历史一", description: "d1", createdAt: 1_000 },
      { clientTicketId: "local-2", title: "历史二", description: "d2", createdAt: 2_000 },
      { clientTicketId: "", title: "坏记录", description: "x" },
    ];
    const first = await call(env, "/api/v1/feedback/tickets/migrate", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_A_TOKEN}` },
      body: JSON.stringify({ records }),
    });
    const firstBody = (await first.json()) as { data?: { migrated: number; skipped: number } };
    assert.deepEqual([firstBody.data?.migrated, firstBody.data?.skipped], [2, 1]);
    const second = await call(env, "/api/v1/feedback/tickets/migrate", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_A_TOKEN}` },
      body: JSON.stringify({ records }),
    });
    const secondBody = (await second.json()) as { data?: { migrated: number; skipped: number } };
    assert.deepEqual([secondBody.data?.migrated, secondBody.data?.skipped], [0, 3]);

    const cookie = await adminLogin(env);
    const list = await call(env, "/api/v1/admin/feedback/tickets?kind=bug", { headers: { cookie } });
    const body = (await list.json()) as { data?: { items?: Array<{ clientTicketId: string | null; createdAt: number }> } };
    const byClient = new Map(body.data?.items?.map((item) => [item.clientTicketId, item]) ?? []);
    assert.equal(byClient.get("local-1")?.createdAt, 1_000);
    assert.equal(byClient.get("local-2")?.createdAt, 2_000);
  });

  it("FB-ACC-04b migrate 认领设备时代的匿名行，不产生重复", async () => {
    const env = createEnv();
    // 设备 token 创建（匿名）且携带 clientTicketId —— 旧版本客户端的 synced 记录形态。
    const deviceToken = await registerDeviceToken(env);
    await createTicket(env, {
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ title: "旧记录", description: "d", clientTicketId: "local-old-1" }),
    });
    const migrated = await call(env, "/api/v1/feedback/tickets/migrate", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_A_TOKEN}` },
      body: JSON.stringify({
        records: [{ clientTicketId: "local-old-1", title: "旧记录", description: "d", createdAt: 5 }],
      }),
    });
    const body = (await migrated.json()) as { data?: { migrated: number; skipped: number } };
    assert.deepEqual([body.data?.migrated, body.data?.skipped], [1, 0]);
    const mine = await call(env, "/api/v1/feedback/tickets/mine", {
      headers: { authorization: `Bearer ${USER_A_TOKEN}` },
    });
    const mineBody = (await mine.json()) as { data?: { total?: number; items?: Array<{ title: string }> } };
    assert.equal(mineBody.data?.total, 1);
    assert.equal(mineBody.data?.items?.[0]?.title, "旧记录");
  });

  it("FB-ACC-05 admin DELETE 清 D1 行与 R2 对象；inline 仅图片放行", async () => {
    const env = createEnv();
    const a = await createTicket(env, {
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_A_TOKEN}` },
      body: JSON.stringify({ title: "del", description: "d" }),
    });
    // 直接种附件行 + R2 对象（附件上传走设备 token 链路，与 DELETE 无耦合）。
    await env.DB.prepare(
      `INSERT INTO feedback_attachments (id, ticket_id, kind, file_name, content_type, size, r2_key, created_at)
       VALUES ('fa_1', ?1, 'screenshot', 's.png', 'image/png', 4, ?2, 1)`,
    ).bind(a.ticketId, `feedback/${a.ticketId}/fa_1`).run();
    await env.FEEDBACK_ARTIFACTS.put(`feedback/${a.ticketId}/fa_1`, new Uint8Array([1, 2, 3, 4]));

    const cookie = await adminLogin(env);
    const inlineResponse = await call(
      env,
      `/api/v1/admin/feedback/tickets/${a.ticketId}/attachments/fa_1?disposition=inline`,
      { headers: { cookie } },
    );
    assert.match(inlineResponse.headers.get("content-disposition") ?? "", /^inline/);
    const zipResponse = await call(
      env,
      `/api/v1/admin/feedback/tickets/${a.ticketId}/attachments/fa_1`,
      { headers: { cookie } },
    );
    // 非 inline 请求对图片默认 attachment；zip（换 content-type）即使带 inline 参数也 attachment。
    assert.match(zipResponse.headers.get("content-disposition") ?? "", /^attachment/);

    const deleted = await call(env, `/api/v1/admin/feedback/tickets/${a.ticketId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(deleted.status, 200);
    const remaining = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback_tickets").first<{ n: number }>();
    assert.equal(remaining?.n, 0);
    const listed = await env.FEEDBACK_ARTIFACTS.list({ prefix: `feedback/${a.ticketId}/` });
    assert.equal(listed.objects.length, 0);
  });

  it("FB-ACC-06 admin logout 清 session cookie", async () => {
    const env = createEnv();
    const cookie = await adminLogin(env);
    const logout = await call(env, "/api/v1/admin/logout", { method: "POST", headers: { cookie } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
  });
});
