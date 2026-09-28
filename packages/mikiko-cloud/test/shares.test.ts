import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/worker.ts";
import { createMemoryKv, createMemoryR2 } from "./helpers.ts";

function createEnv() {
  return {
    MIKIKO_BUILTIN_CONFIG: createMemoryKv(),
    MIKIKO_CLIENT_CONFIG: createMemoryKv(),
    MIKIKO_SHARE: createMemoryKv(),
    SHARE_ARTIFACTS: createMemoryR2(),
    MIKIKO_ADMIN_USERNAME: "admin",
    MIKIKO_ADMIN_PASSWORD: "pw",
    MIKIKO_ADMIN_SESSION_SECRET: "secret",
  };
}

function call(
  env: ReturnType<typeof createEnv>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return worker.fetch(
    new Request(`https://agent.mikiko.ai${path}`, init),
    env,
  ) as Promise<Response>;
}

async function registerDevice(env: ReturnType<typeof createEnv>): Promise<string> {
  const response = await call(env, "/api/v1/shares/device/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "a".repeat(64) }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: { device_token: string } };
  return body.data.device_token;
}

async function sha256Hex(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

const legacySha = sha256Hex;

// payload_sha256 是客户端对整个 confirm 请求的哈希声明，服务端仅存档不比对
// （此前误加的一致性校验曾拦截全部真实发布）。
const PREPARATION_BODY = {
  client_request_id: "req-1",
  title: "测试分享",
  schema_version: 1,
  access_mode: "public_importable",
  payload_sha256: "0".repeat(64),
  artifact_count: 0,
};

const CONFIRM_BODY = {
  selected_product_turn_ids: ["turn-1"],
  projection: {
    rows: [
      { kind: "user", id: "r1", text: "你好" },
      { kind: "assistant", id: "r2", text: "你好，有什么可以帮你？" },
    ],
  },
  integrity: {
    projection_sha256: "1".repeat(64),
    artifact_set_sha256: "2".repeat(64),
  },
  disclosure_confirmation: {
    version: 1,
    accepted_at: 1,
    acknowledged_no_secret_detection: true,
  },
};

describe("分享：设备注册与鉴权", () => {
  it("多 secret 并存：重注册不吊销旧 token，超限淘汰最旧（2026-09-28 401 互踢修复）", async () => {
    const env = createEnv();
    const tokens: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const response = await call(env, "/api/v1/shares/device/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "b".repeat(64) }),
      });
      assert.equal(response.status, 200);
      tokens.push(
        ((await response.json()) as { data: { device_token: string } }).data.device_token,
      );
    }
    // 上限 5：最近 5 个 token 全部可用，最早的 2 个已被淘汰。
    for (const token of tokens.slice(2)) {
      const ok = await call(env, "/api/v1/shares/capabilities", {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(ok.status, 200, "新注册不吊销仍在限额内的旧 token");
    }
    for (const token of tokens.slice(0, 2)) {
      const evicted = await call(env, "/api/v1/shares/capabilities", {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(evicted.status, 401, "超限最旧 token 被淘汰");
    }
  });

  it("历史单 secret 记录仍可验证（KV 旧形状兼容）", async () => {
    const env = createEnv();
    await env.MIKIKO_SHARE.put(
      "device:" + "c".repeat(64),
      JSON.stringify({ secretHash: await legacySha("legacy-secret") }),
    );
    const legacy = await call(env, "/api/v1/shares/capabilities", {
      headers: { authorization: `Bearer ${"c".repeat(64)}.legacy-secret` },
    });
    assert.equal(legacy.status, 200);
  });

  it("注册返回设备 token；capabilities 需要合法 token", async () => {
    const env = createEnv();
    const token = await registerDevice(env);

    const unauthorized = await call(env, "/api/v1/shares/capabilities");
    assert.equal(unauthorized.status, 401);

    const authorized = await call(env, "/api/v1/shares/capabilities", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(authorized.status, 200);
    const body = (await authorized.json()) as {
      data: { schema_version: number; access_modes: string[] };
    };
    assert.equal(body.data.schema_version, 1);
    assert.deepEqual(body.data.access_modes, ["private", "public_readonly", "public_importable"]);
  });

  it("非法 deviceId 与伪造 token 被拒绝", async () => {
    const env = createEnv();
    const bad = await call(env, "/api/v1/shares/device/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "not-hex!" }),
    });
    assert.equal(bad.status, 400);

    const forged = await call(env, "/api/v1/shares/capabilities", {
      headers: { authorization: `Bearer ${"f".repeat(64)}.forged` },
    });
    assert.equal(forged.status, 401);
  });
});

describe("分享：发布全流程", () => {
  it("prepare → confirm → 公开 preview 与 continuation", async () => {
    const env = createEnv();
    const token = await registerDevice(env);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const prep = await call(env, "/api/v1/shares/preparations", {
      method: "POST",
      headers,
      body: JSON.stringify(PREPARATION_BODY),
    });
    assert.equal(prep.status, 200);
    const prepBody = (await prep.json()) as { data: { preparation_id: string; status: string } };
    assert.equal(prepBody.data.status, "preparing");

    const confirm = await call(
      env,
      `/api/v1/shares/preparations/${prepBody.data.preparation_id}/confirm`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(CONFIRM_BODY),
      },
    );
    assert.equal(confirm.status, 200);
    const confirmBody = (await confirm.json()) as {
      data: { share_code: string; share_url: string; access_mode: string };
    };
    assert.match(
      confirmBody.data.share_url,
      /^https:\/\/agent\.mikiko\.ai\/cn\/share\/[a-z0-9]{10}$/u,
    );
    const code = confirmBody.data.share_code;

    const preview = await call(env, `/api/v1/shares/${code}/preview`);
    assert.equal(preview.status, 200);
    const previewBody = (await preview.json()) as {
      data: {
        schema_version: number;
        share: { title: string; access_mode: string };
        rows: unknown[];
      };
    };
    assert.equal(previewBody.data.share.title, "测试分享");
    assert.equal(previewBody.data.rows.length, 2);

    const continuation = await call(env, `/api/v1/shares/${code}/continuation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_version: 1, client_request_id: "import-1" }),
    });
    assert.equal(continuation.status, 200);
    const continuationBody = (await continuation.json()) as {
      data: { import_grant_id: string; share: { share_id: string } };
    };
    assert.ok(continuationBody.data.import_grant_id.length > 0);
    assert.ok(continuationBody.data.share.share_id.length > 0);
  });

  it("非 importable 分享的 continuation 被拒绝（3214）", async () => {
    const env = createEnv();
    const token = await registerDevice(env);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const prep = await call(env, "/api/v1/shares/preparations", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...PREPARATION_BODY, access_mode: "public_readonly" }),
    });
    const prepBody = (await prep.json()) as { data: { preparation_id: string } };
    const confirm = await call(
      env,
      `/api/v1/shares/preparations/${prepBody.data.preparation_id}/confirm`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(CONFIRM_BODY),
      },
    );
    const code = ((await confirm.json()) as { data: { share_code: string } }).data.share_code;

    const continuation = await call(env, `/api/v1/shares/${code}/continuation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_version: 1, client_request_id: "import-2" }),
    });
    assert.equal(continuation.status, 403);
    const errorBody = (await continuation.json()) as { code: number };
    assert.equal(errorBody.code, 3214);
  });

  it("artifact 上传：sha256 不匹配被拒；匹配后可从公开端点下载", async () => {
    const env = createEnv();
    const token = await registerDevice(env);
    const headers = { authorization: `Bearer ${token}` };

    const content = "hello artifact";
    const sha = await sha256Hex(content);
    const prep = await call(env, "/api/v1/shares/preparations", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ ...PREPARATION_BODY, artifact_count: 1 }),
    });
    const preparationId = ((await prep.json()) as { data: { preparation_id: string } }).data
      .preparation_id;

    const descriptor = {
      artifact_id: "art-1",
      logical_artifact_key: "key-1",
      producer_product_turn_id: "turn-1",
      artifact_version: 1,
      state: "current",
      ref: "zcode-artifact://share/art-1",
      artifact_type: "md",
      display_name: "result.md",
      extension: "md",
      mime_type: "text/markdown",
      size_bytes: content.length,
      sha256: await sha256Hex("tampered"),
    };
    const uploadForm = new FormData();
    uploadForm.append("descriptor", JSON.stringify(descriptor));
    uploadForm.append("file", new File([content], "result.md", { type: "text/markdown" }));
    const mismatch = await call(env, `/api/v1/shares/preparations/${preparationId}/artifacts`, {
      method: "POST",
      headers,
      body: uploadForm,
    });
    assert.equal(mismatch.status, 400);

    descriptor.sha256 = sha;
    const uploadForm2 = new FormData();
    uploadForm2.append("descriptor", JSON.stringify(descriptor));
    uploadForm2.append("file", new File([content], "result.md", { type: "text/markdown" }));
    const uploaded = await call(env, `/api/v1/shares/preparations/${preparationId}/artifacts`, {
      method: "POST",
      headers,
      body: uploadForm2,
    });
    assert.equal(uploaded.status, 200);
    const uploadBody = (await uploaded.json()) as {
      data: { status: string; safety_status: string };
    };
    assert.equal(uploadBody.data.status, "uploaded");
    assert.equal(uploadBody.data.safety_status, "clean");

    const confirm = await call(env, `/api/v1/shares/preparations/${preparationId}/confirm`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(CONFIRM_BODY),
    });
    assert.equal(confirm.status, 200);
    const code = ((await confirm.json()) as { data: { share_code: string } }).data.share_code;

    const download = await call(env, `/api/v1/shares/${code}/artifacts/art-1`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), content);
    assert.equal(download.headers.get("content-type"), "text/markdown");
  });
});

describe("分享：private 口令门", () => {
  async function publishPrivate(
    env: ReturnType<typeof createEnv>,
  ): Promise<{ code: string; url: string }> {
    const token = await registerDevice(env);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const prep = await call(env, "/api/v1/shares/preparations", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...PREPARATION_BODY, access_mode: "private" }),
    });
    const preparationId = ((await prep.json()) as { data: { preparation_id: string } }).data
      .preparation_id;
    const confirm = await call(env, `/api/v1/shares/preparations/${preparationId}/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify(CONFIRM_BODY),
    });
    assert.equal(confirm.status, 200);
    const record = ((await confirm.json()) as { data: { share_code: string; share_url: string } })
      .data;
    return { code: record.share_code, url: record.share_url };
  }

  it("private 发布自动生成口令并附在 share_url；无口令/错口令 403，对口令可读", async () => {
    const env = createEnv();
    const { code, url } = await publishPrivate(env);
    assert.match(url, /^https:\/\/agent\.mikiko\.ai\/cn\/share\/[a-z0-9]{10}\?pwd=[a-z2-9]{8}$/u);
    const pwd = new URL(url).searchParams.get("pwd")!;

    const missing = await call(env, `/api/v1/shares/${code}/preview`);
    assert.equal(missing.status, 403);
    assert.equal(((await missing.json()) as { msg: string }).msg, "password_required");

    const wrong = await call(env, `/api/v1/shares/${code}/preview?pwd=wrongpwd`);
    assert.equal(wrong.status, 403);
    assert.equal(((await wrong.json()) as { msg: string }).msg, "password_mismatch");

    const ok = await call(env, `/api/v1/shares/${code}/preview?pwd=${pwd}`);
    assert.equal(ok.status, 200);
    assert.equal(
      ((await ok.json()) as { data: { share: { access_mode: string } } }).data.share.access_mode,
      "private",
    );
  });

  it("public_readonly 分享不受口令门影响", async () => {
    const env = createEnv();
    const token = await registerDevice(env);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const prep = await call(env, "/api/v1/shares/preparations", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...PREPARATION_BODY, access_mode: "public_readonly" }),
    });
    const preparationId = ((await prep.json()) as { data: { preparation_id: string } }).data
      .preparation_id;
    const confirm = await call(env, `/api/v1/shares/preparations/${preparationId}/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify(CONFIRM_BODY),
    });
    const record = ((await confirm.json()) as { data: { share_code: string; share_url: string } })
      .data;
    assert.doesNotMatch(record.share_url, /pwd/u);
    const preview = await call(env, `/api/v1/shares/${record.share_code}/preview`);
    assert.equal(preview.status, 200);
  });
});

describe("分享：IP 限流", () => {
  it("发布类请求默认每分钟 3 次，第 4 次 429（3002）", async () => {
    const env = createEnv();
    const token = await registerDevice(env);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    for (let index = 0; index < 3; index += 1) {
      const response = await call(env, "/api/v1/shares/preparations", {
        method: "POST",
        headers,
        body: JSON.stringify(PREPARATION_BODY),
      });
      assert.equal(response.status, 200, `第 ${index + 1} 次发布应放行`);
    }
    const fourth = await call(env, "/api/v1/shares/preparations", {
      method: "POST",
      headers,
      body: JSON.stringify(PREPARATION_BODY),
    });
    assert.equal(fourth.status, 429);
    const errorBody = (await fourth.json()) as { code: number };
    assert.equal(errorBody.code, 3002);
  });

  it("限流阈值跟随 MIKIKO_CLIENT_CONFIG 下发值（调至 1）", async () => {
    const env = createEnv();
    await env.MIKIKO_CLIENT_CONFIG.put(
      "client-configs",
      JSON.stringify({
        dynamicWorkflow: { mode: "alwaysOn" },
        share: { publishPerMinutePerIp: 1 },
      }),
    );
    const token = await registerDevice(env);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const first = await call(env, "/api/v1/shares/preparations", {
      method: "POST",
      headers,
      body: JSON.stringify(PREPARATION_BODY),
    });
    assert.equal(first.status, 200);
    const second = await call(env, "/api/v1/shares/preparations", {
      method: "POST",
      headers,
      body: JSON.stringify(PREPARATION_BODY),
    });
    assert.equal(second.status, 429);
  });
});
