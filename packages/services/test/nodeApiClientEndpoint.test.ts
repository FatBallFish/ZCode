import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import { createNodeApiClient } from "../src/providers/api/nodeApiClient.js";
import { buildZCodeSourceHeaders, ZCODE_SOURCE_HEADERS } from "../src/providers/sourceHeaders.js";

describe("NodeApiClient endpoint rewriting", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    setDataBaseDir(null);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites only the configured zcode endpoint origin", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => "http://localhost:3030",
    });

    await client.request(`${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/api/v1/event/report?x=1`);
    await client.request("https://example.com/static/config.json");
    await client.request("https://feedback.example.invalid/api/v1/tickets");
    await client.request("https://api.z.ai/v1/models");

    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      "http://localhost:3030/api/v1/event/report?x=1",
      "https://example.com/static/config.json",
      "https://feedback.example.invalid/api/v1/tickets",
      "https://api.z.ai/v1/models",
    ]);
  });

  it("自建产品域与官方账号域共存时，真实 loopback 服务收到 balance 必需设备来源头", async () => {
    const dataBaseDir = mkdtempSync(join(tmpdir(), "mikiko-official-account-headers-"));
    tempDirs.push(dataBaseDir);
    setDataBaseDir(dataBaseDir);
    const configDir = join(dataBaseDir, ".mikiko", "v2");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "fixture-mid" }),
    );
    const received: Array<{ path: string; headers: Headers }> = [];
    const server = createServer((request, response) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      }
      received.push({ path: request.url ?? "", headers });
      response.writeHead(headers.get("X-Device-Mid") ? 200 : 400, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify({ code: headers.get("X-Device-Mid") ? 0 : 3001 }));
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing loopback address");
      const client = createNodeApiClient({
        resolveZCodeEndpointOrigin: () => "https://private-product.example",
        fetchImpl: async (input, init) => {
          const url = new URL(String(input));
          expect(url.origin).toBe("https://zcode.z.ai");
          return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
        },
      });
      const result = await client.request(
        "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=1.1.3",
        {
          headers: {
            Authorization: "Bearer fixture-official-account",
            "X-ZCode-App-Version": "1.1.3",
          },
        },
      );
      expect(result.status).toBe(200);
      expect(received[0]?.path).toBe("/api/v1/zcode-plan/billing/balance?app_version=1.1.3");
      expect(received[0]?.headers.get("X-Device-Mid")).toBe("fixture-mid");
      expect(received[0]?.headers.get("X-Platform")).toBe(`${process.platform}-${process.arch}`);
      expect(received[0]?.headers.get("X-ZCode-App-Version")).toBe("1.1.3");
      expect(received[0]?.headers.get("Authorization")).toBe("Bearer fixture-official-account");
      expect(received[0]?.headers.get("HTTP-Referer")).toBe("https://zcode.z.ai");
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("官方账号之外的官方产品路径与任意第三方不获得设备来源头", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const client = createNodeApiClient({ fetchImpl: fetchImpl as typeof fetch });
    await client.request("https://zcode.z.ai/api/v1/remote/token");
    await client.request("https://zcode.z.ai/api/v1/marketing/touch");
    await client.request("https://third-party.example/api/v1/zcode-plan/billing/balance");
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get("X-Platform")).toBeNull();
      expect(new Headers(init?.headers).get("X-Device-Mid")).toBeNull();
    }
  });

  it("只给当前 zcode endpoint 请求统一补来源 headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => "https://zcode.z.ai",
    });

    await client.request(`${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/api/v1/client/configs`);
    await client.request("https://api.z.ai/v1/models");

    const zcodeHeaders = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(zcodeHeaders.get("User-Agent")).toMatch(/^Mikiko\//);
    expect(zcodeHeaders.get("X-Title")).toBe(ZCODE_SOURCE_HEADERS["X-Title"]);
    expect(zcodeHeaders.get("X-OpenRouter-Title")).toBeNull();
    expect(zcodeHeaders.get("X-OpenRouter-Categories")).toBeNull();
    expect(zcodeHeaders.get("HTTP-Referer")).toBe("https://zcode.z.ai");
    expect(zcodeHeaders.get("X-App-Version")).toBeNull();
    expect(zcodeHeaders.get("X-ZCode-App-Version")).toBeTruthy();
    expect(zcodeHeaders.get("X-Platform")).toBe(`${process.platform}-${process.arch}`);
    expect(zcodeHeaders.get("X-Release-Channel")).toBeTruthy();
    expect(zcodeHeaders.get("X-Client-Language")).toBeTruthy();
    expect(zcodeHeaders.get("X-Client-Timezone")).toBeTruthy();
    expect(zcodeHeaders.get("X-Os-Category")).toBeTruthy();
    expect(zcodeHeaders.get("X-Os-Version")).toBeTruthy();
    expect(zcodeHeaders.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const externalHeaders = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers);
    expect(externalHeaders.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(externalHeaders.get("User-Agent")).toBeNull();
  });

  it("保留调用方显式传入的 zcode endpoint headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => "https://zcode.z.ai",
    });

    await client.request(`${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/api/v1/oauth/token`, {
      headers: {
        "User-Agent": "CustomAgent/1.0",
        "X-Device-Mid": "caller-device-mid",
        "X-Title": "Custom Title",
        Authorization: "Bearer token",
      },
    });

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("User-Agent")).toBe("CustomAgent/1.0");
    expect(headers.get("X-Title")).toBe("Custom Title");
    expect(headers.get("X-OpenRouter-Title")).toBeNull();
    expect(headers.get("X-OpenRouter-Categories")).toBeNull();
    expect(headers.get("Authorization")).toBe("Bearer token");
    expect(headers.get("X-Device-Mid")).toBe("caller-device-mid");
    expect(headers.get("HTTP-Referer")).toBe("https://zcode.z.ai");
    expect(headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("X-Client-Language 跟随注入的界面语言，而不是进程 Intl locale", async () => {
    // 从 Dock 启动时进程无 LANG，Intl 回退 en-US；界面语言才是唯一数据源。
    const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    const intlSpy = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockImplementation(function (this: Intl.DateTimeFormat) {
        return { ...resolvedOptions.call(this), locale: "en-US" };
      });
    let uiLocale = "zh-CN";
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => "https://zcode.z.ai",
      resolveClientLanguage: () => uiLocale,
    });

    try {
      await client.request(`${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/api/v1/zcode-plan/billing/balance`);
      uiLocale = "en-US";
      await client.request(`${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/api/v1/client/configs`);
      uiLocale = "zh-CN";
      await client.request(`${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/api/v1/marketing/touch`, {
        headers: { "X-Client-Language": "en-US" },
      });
    } finally {
      intlSpy.mockRestore();
    }

    const languages = fetchImpl.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("X-Client-Language"),
    );
    // 切换语言后下一次请求立即生效；调用方显式传入的值仍然优先。
    expect(languages).toEqual(["zh-CN", "en-US", "en-US"]);
  });

  it("尚未收到界面语言时回退 Intl locale", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => "https://zcode.z.ai",
      resolveClientLanguage: () => undefined,
    });

    await client.request(`${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/api/v1/client/configs`);

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-Client-Language")).toBe(buildZCodeSourceHeaders()["X-Client-Language"]);
  });

  it("给当前 zcode endpoint 请求补既有 deviceMid header", async () => {
    const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-device-mid-"));
    tempDirs.push(dataBaseDir);
    setDataBaseDir(dataBaseDir);
    const configDir = join(dataBaseDir, ".mikiko", "v2");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "device-mid-1" }),
      "utf-8",
    );

    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => "https://zcode.z.ai",
    });

    await client.request(`${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/api/v1/client/configs`);

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-Device-Mid")).toBe("device-mid-1");
  });

  it.each([
    { name: "state 文件缺失", content: null },
    { name: "state JSON 损坏", content: "{" },
    { name: "deviceMid 为空字符串", content: JSON.stringify({ deviceMid: "" }) },
    { name: "deviceMid 含不可打印字符", content: JSON.stringify({ deviceMid: "mid\n1" }) },
  ])("$name 时不注入 deviceMid header", async ({ content }) => {
    const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-device-mid-invalid-"));
    tempDirs.push(dataBaseDir);
    setDataBaseDir(dataBaseDir);
    const configDir = join(dataBaseDir, ".mikiko", "v2");
    mkdirSync(configDir, { recursive: true });
    if (content !== null) {
      writeFileSync(join(configDir, "telemetry-state.json"), content, "utf-8");
    }

    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => "https://zcode.z.ai",
    });

    await client.request(`${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/api/v1/client/configs`);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-Device-Mid")).toBeNull();
  });

  it("统一来源 headers 支持可控的客户端上下文字段", () => {
    expect(
      buildZCodeSourceHeaders({
        appVersion: "2.14.0",
        arch: "arm64",
        clientLanguage: "zh-CN",
        clientTimezone: "Asia/Shanghai",
        osVersion: "Darwin 25.0.0",
        platform: "darwin",
        releaseChannel: "production",
      }),
    ).toMatchObject({
      "X-Platform": "darwin-arm64",
      "X-Release-Channel": "production",
      "X-Client-Language": "zh-CN",
      "X-Client-Timezone": "Asia/Shanghai",
      "X-Os-Category": "macos",
      "X-Os-Version": "Darwin 25.0.0",
      "X-ZCode-App-Version": "2.14.0",
    });
  });
});
