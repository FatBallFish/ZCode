import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createFeedbackService } from "../src/feedback/feedbackService.js";
import type { IOAuthService } from "../src/oauth/oauth.js";
import { getFeedbackAttachmentDir, setDataBaseDir } from "../src/paths.js";
import { describe, expect, it, vi } from "vitest";
import { MikikoFeedbackHttpClient } from "../src/feedback/mikikoFeedbackHttpClient.js";
import type { ApiRequestInit } from "@zcode/shared";

describe("工单发送隐私边界（mikiko 自建客户端）", () => {
  it("创建请求脱敏文本，保留用户联系方式", async () => {
    const bodies: string[] = [];
    const request = vi.fn(async (_url: string | URL | Request, init?: ApiRequestInit) => {
      bodies.push(String(init?.body));
      return new Response(
        JSON.stringify({ code: 0, data: { ticketId: "fb_test", status: "pending_triage" } }),
      );
    });
    const client = new MikikoFeedbackHttpClient({
      baseUrl: "https://agent.mikiko.invalid/api/v1",
      apiClient: { request },
      getDeviceToken: async () => "token",
      reacquireDeviceToken: async () => "token",
    });
    await client.create({
      title: "https://hooks.slack.com/services/T000/B000/title-path-canary API_KEY=title-canary",
      description: [
        "请帮助我，token=body-canary",
        "https://example.com/reset/body-path-canary",
        JSON.stringify({ url: "https://files.example.com/object-path-canary?sig=sig-canary" }),
        JSON.stringify({ error: 'failed config: {"apiKey":"embedded-canary"}' }),
        '[info] {"apiKey":"prefix-canary"} {"status":401}',
        '{"cookie":"truncated-canary',
      ].join("\n"),
      type: "bug",
      contact: "user@example.com",
      device: {
        appVersion: "1.0",
        agentModelOptionsPreview: ["private-model-canary"],
        hostname: "host-canary",
      } as never,
    });
    const sent = bodies.join("\n");
    for (const secret of [
      "title-canary",
      "title-path-canary",
      "body-path-canary",
      "object-path-canary",
      "sig-canary",
      "body-canary",
      "embedded-canary",
      "prefix-canary",
      "truncated-canary",
    ])
      expect(sent).not.toContain(secret);
    expect(sent).toContain("user@example.com");
    expect(sent).toContain("请帮助我");
    expect(sent).toContain("1.0");
  });

  it("401 时用新 token 重试一次，业务错误码抛 MikikoFeedbackRequestError", async () => {
    const calls: string[] = [];
    let token = "stale";
    const request = vi.fn(async (_url: string | URL | Request, init?: ApiRequestInit) => {
      calls.push(String(init?.headers && (init.headers as Record<string, string>).authorization));
      if (token === "stale") {
        token = "refreshed";
        return new Response(JSON.stringify({ code: 3401, msg: "authentication_required" }), {
          status: 401,
        });
      }
      return new Response(
        JSON.stringify({ code: 0, data: { ticketId: "fb_retry", status: "pending_triage" } }),
      );
    });
    const client = new MikikoFeedbackHttpClient({
      baseUrl: "https://agent.mikiko.invalid/api/v1",
      apiClient: { request },
      getDeviceToken: async () => token,
      reacquireDeviceToken: async () => {
        token = "refreshed";
        return token;
      },
    });
    const ticket = await client.create({
      title: "t",
      description: "d",
      type: "bug",
      device: { appVersion: "1.0" } as never,
    });
    expect(ticket.id).toBe("fb_retry");
    expect(calls).toEqual(["Bearer stale", "Bearer refreshed"]);

    const errorRequest = vi.fn(async () =>
      new Response(JSON.stringify({ code: 3403, msg: "invalid_body" }), { status: 400 }),
    );
    const errorClient = new MikikoFeedbackHttpClient({
      baseUrl: "https://agent.mikiko.invalid/api/v1",
      apiClient: { request: errorRequest },
      getDeviceToken: async () => "token",
      reacquireDeviceToken: async () => "token",
    });
    await expect(
      errorClient.create({ title: "t", description: "d", type: "bug", device: { appVersion: "1" } as never }),
    ).rejects.toMatchObject({ name: "MikikoFeedbackRequestError", message: "invalid_body" });
  });
});

it("附件文件名不能越出临时目录，上传后清理暂存数据", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-attachment-privacy-"));
  setDataBaseDir(root);
  let uploadedPath = "";
  const upload = vi
    .spyOn(MikikoFeedbackHttpClient.prototype, "uploadFile")
    .mockImplementation(async (_id, _kind, path, filename) => {
      uploadedPath = path;
      expect(path.startsWith(getFeedbackAttachmentDir())).toBe(true);
      expect(basename(path)).toBe("content");
      expect(filename).toBe("private.png");
      expect(await readFile(path, "utf8")).toBe("synthetic-image");
      return {
        id: 1,
        kind: "image",
        filename,
        size: 14,
        redacted: true,
        created_at: new Date().toISOString(),
      };
    });
  try {
    const service = createFeedbackService({
      credentialService: { load: async () => null, save: async () => {}, delete: async () => {} },
      oauthService: {} as IOAuthService,
      apiClient: { request: vi.fn() },
    });
    await service.uploadAttachmentData("ticket", "image", {
      filename: "../../private.png",
      dataBase64: Buffer.from("synthetic-image").toString("base64"),
      contentType: "image/png",
    });
    expect(upload).toHaveBeenCalledOnce();
    await expect(access(uploadedPath)).rejects.toThrow();
  } finally {
    upload.mockRestore();
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  }
});
