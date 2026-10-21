import { describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createProviderEndpointRoutingFetch } from "@zcode/adapters/model";
import type { Logger } from "@zcode/contracts";
import { resolveProcessProviderEndpointRoutingPort } from "../src/provider-endpoint-routing.js";

describe("resolveProcessProviderEndpointRoutingPort", () => {
  it("shares one process snapshot owner for the same endpoint and network policy", () => {
    const env = {
      MIKIKO_ENV: "test",
      MIKIKO_BASE_URL: "https://routing-config.example.test",
    };
    const network = {
      httpProxy: "http://proxy.example.test:8080",
      noProxy: "routing-config.example.test",
    };

    const first = resolveProcessProviderEndpointRoutingPort({
      appVersion: "1.2.3",
      env,
      logger,
      network,
    });
    const second = resolveProcessProviderEndpointRoutingPort({
      appVersion: "9.9.9",
      env: { ...env },
      logger,
      network: { ...network },
    });

    expect(second).toBe(first);
  });

  it("shares the official account route across production product origins", () => {
    const create = (origin: string) =>
      resolveProcessProviderEndpointRoutingPort({
        env: { MIKIKO_ENV: "production", MIKIKO_BASE_URL: origin },
        logger,
        network: {},
      });
    expect(create("https://first.example.test")).toBe(create("https://second.example.test"));
  });

  it.each([
    {},
    { MIKIKO_ENV: "production", MIKIKO_BASE_URL: "https://agent.mikiko.ai" },
    { MIKIKO_ENV: "production", MIKIKO_BASE_URL: "https://product.example.test" },
    { MIKIKO_ENV: "production", MIKIKO_ENDPOINT_ORIGIN: "https://endpoint.example.test" },
    { ZCODE_ENV: "production", ZCODE_BASE_URL: "https://legacy.example.test" },
  ])("keeps both official account gateways off the product origin: %j", async (env) => {
    const port = resolveProcessProviderEndpointRoutingPort({ env, logger, network: {} });
    for (const [source, target] of [
      ["https://open.bigmodel.cn", "ultra"],
      ["https://api.z.ai", "ultra-zai"],
    ]) {
      await expect(port.resolve(`${source}/api/anthropic/v1/messages?trace=a%2Bb`)).resolves.toEqual({
        routed: true,
        url: `https://zcode.z.ai/api/v1/${target}/anthropic/v1/messages?trace=a%2Bb`,
      });
    }
  });

  it("isolates ports when the explicit test account origin changes", () => {
    const create = (origin: string) =>
      resolveProcessProviderEndpointRoutingPort({
        env: { MIKIKO_ENV: "test", MIKIKO_BASE_URL: origin },
        logger,
        network: {},
      });
    expect(create("https://first.example.test")).not.toBe(create("https://second.example.test"));
  });

  it("sends the assembled account route through real HTTP with auth/body/query intact", async () => {
    const received: Array<{ url: string; auth: string | undefined; body: string }> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        url: request.url!,
        auth: request.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: fixture\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const transport = createProviderEndpointRoutingFetch({
        routingPort: resolveProcessProviderEndpointRoutingPort({
          env: { MIKIKO_ENV: "test", MIKIKO_BASE_URL: origin },
          logger,
          network: {},
        }),
        fetch: globalThis.fetch,
      });
      const body = JSON.stringify({ model: "GLM-5.3-Flash", stream: true, messages: [] });
      const response = await transport("https://open.bigmodel.cn/api/anthropic/v1/messages?q=a%2Bb", {
        method: "POST",
        headers: { Host: "open.bigmodel.cn", Authorization: "Bearer synthetic-fixture" },
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("data: fixture\n\n");
      expect(received).toEqual([
        {
          url: "/api/v1/ultra/anthropic/v1/messages?q=a%2Bb",
          auth: "Bearer synthetic-fixture",
          body,
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("isolates snapshots when the network policy changes", () => {
    const env = {
      MIKIKO_ENV: "test",
      MIKIKO_BASE_URL: "https://routing-config-network.example.test",
    };
    const direct = resolveProcessProviderEndpointRoutingPort({
      appVersion: "1.2.3",
      env,
      logger,
      network: {},
    });
    const proxied = resolveProcessProviderEndpointRoutingPort({
      appVersion: "1.2.3",
      env,
      logger,
      network: { httpProxy: "http://proxy.example.test:8080" },
    });

    expect(proxied).not.toBe(direct);
  });
});

const logger: Logger = {
  child: () => logger,
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};
