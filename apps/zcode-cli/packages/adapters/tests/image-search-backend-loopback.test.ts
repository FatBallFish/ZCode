import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { createOfficialMcpAuthFetch } from "../src/mcp/official-auth.js";

it("Image Search 用合成账号完成真实 HTTP initialize/list/call/resource，未登录时零请求", async () => {
  const seen: Array<{ method: string; authorization: string; maas: string }> = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const rpc = JSON.parse(body);
      seen.push({
        method: rpc.method,
        authorization: String(request.headers.authorization ?? ""),
        maas: String(request.headers["x-bigmodel-authorization"] ?? ""),
      });
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        rpc.method === "initialize"
          ? {
              protocolVersion: rpc.params.protocolVersion,
              serverInfo: { name: "mikiko-image-fixture", version: "1" },
              capabilities: { tools: {}, resources: {} },
            }
          : rpc.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "image_search",
                    description: "Local fixture",
                    inputSchema: { type: "object", properties: { query: { type: "string" } } },
                    _meta: { ui: { resourceUri: "ui://image-search/panel.html" } },
                  },
                ],
              }
            : rpc.method === "tools/call"
              ? { content: [{ type: "text", text: "fixture image result" }] }
              : rpc.method === "resources/read"
                ? {
                    contents: [
                      {
                        uri: rpc.params.uri,
                        mimeType: "text/html;profile=mcp-app",
                        text: '<div id="root">Mikiko image fixture</div>',
                      },
                    ],
                  }
                : { resources: [] };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    } catch {
      response.writeHead(500).end();
    }
  });
  const clients: Client[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const official = {
      pluginId: "image-search@zcode-plugins-official",
      mcpKey: "image_search",
      source: "plugin" as const,
    };
    const trustedOrigins = { isTrusted: async () => ({ trusted: true }) };
    const denied = new Client({ name: "mikiko-image-denied-fixture", version: "1" });
    clients.push(denied);
    const deniedFetch = createOfficialMcpAuthFetch({
      official,
      trustedOrigins,
      baseFetch: fetch,
      serverName: "plugin:image-search:image_search",
      url: url.toString(),
      authHeadersPort: {
        resolveHeaders: async () => ({ ok: false, reason: "official_auth_unavailable" }),
      },
    });
    await expect(
      denied.connect(new StreamableHTTPClientTransport(url, { fetch: deniedFetch })),
    ).rejects.toThrow("Image Search");
    expect(seen).toEqual([]);
    const client = new Client({ name: "mikiko-image-authorized-fixture", version: "1" });
    clients.push(client);
    const authenticatedFetch = createOfficialMcpAuthFetch({
      official,
      trustedOrigins,
      baseFetch: fetch,
      serverName: "plugin:image-search:image_search",
      url: url.toString(),
      authHeadersPort: {
        resolveHeaders: async () => ({
          ok: true,
          headers: {
            Authorization: "Bearer synthetic-account",
            "X-Bigmodel-Authorization": "Bearer synthetic-maas",
          },
        }),
      },
    });
    await client.connect(new StreamableHTTPClientTransport(url, { fetch: authenticatedFetch }));
    expect((await client.listTools()).tools[0]?.name).toBe("image_search");
    expect(
      (await client.callTool({ name: "image_search", arguments: { query: "synthetic fixture" } }))
        .content,
    ).toEqual([{ type: "text", text: "fixture image result" }]);
    expect(
      (await client.readResource({ uri: "ui://image-search/panel.html" })).contents[0],
    ).toMatchObject({ text: '<div id="root">Mikiko image fixture</div>' });
    expect(seen.map((item) => item.method)).toEqual(
      expect.arrayContaining(["initialize", "tools/list", "tools/call", "resources/read"]),
    );
    expect(
      seen.every(
        (item) =>
          item.authorization === "Bearer synthetic-account" &&
          item.maas === "Bearer synthetic-maas",
      ),
    ).toBe(true);
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
