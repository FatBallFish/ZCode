const { appendFile } = require("node:fs/promises");
const { basename } = require("node:path");
const { createInterface } = require("node:readline");

let writes = Promise.resolve();
function audit(event) {
  writes = writes.then(() =>
    appendFile(process.env.MIKIKO_FAKE_NATIVE_AUDIT, JSON.stringify(event) + "\n"),
  );
  return writes;
}

// The same fixture can observe gateway lifecycle through --require without intercepting its IO.
const nativeMode = basename(process.argv[1] || "") === "mcp" || process.argv[2] === "mcp";
if (!nativeMode) {
  process.on("SIGTERM", () => {
    void audit({ kind: "gateway-signal", signal: "SIGTERM", pid: process.pid });
  });
  process.once("beforeExit", () => {
    void audit({ kind: "gateway-exit", pid: process.pid });
  });
} else {
  const image = {
    type: "image",
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKfkAAAAASUVORK5CYII=",
  };
  const properties = {
    app: { type: "string" },
    element_index: { type: "string" },
    value: { type: "string" },
    text: { type: "string" },
    role: { type: "string" },
    include_ax: { type: "boolean" },
    include_screenshot: { type: "boolean" },
    window_placement: { type: "string", enum: ["keep", "agent_display"] },
    key_method: { type: "string", enum: ["auto", "sky_key"] },
    click_method: { type: "string", enum: ["accessibility", "global"] },
    x: { type: "number" },
    y: { type: "number" },
    unsafe_native_only: { type: "string" },
  };
  const tools = [
    "list_apps",
    "get_app_state",
    "query",
    "click",
    "drag",
    "set_value",
    "type_text",
    "press_key",
  ].map((name) => ({
    name,
    description: `Fixture native ${name}`,
    inputSchema: { type: "object", properties, required: ["app"] },
  }));
  const input = createInterface({ input: process.stdin });
  let requests = Promise.resolve();
  void audit({
    kind: "native-start",
    pid: process.pid,
    parentPid: process.ppid,
    env: {
      visualCursor: process.env.MIKIKO_COMPUTER_USE_VISUAL_CURSOR,
      globalPointer: process.env.MIKIKO_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS,
      namespace: process.env.MIKIKO_COMPUTER_USE_AGENT_SOCKET_NAMESPACE,
      appAgentProxyDisabled: process.env.MIKIKO_COMPUTER_USE_DISABLE_APP_AGENT_PROXY,
    },
  });
  input.on("line", (line) => {
    requests = requests
      .then(async () => {
        const request = JSON.parse(line);
        if (request.id === undefined) {
          await audit({
            kind:
              request.method === "notifications/turn-ended"
                ? "native-turn-ended"
                : "native-notification",
            method: request.method,
          });
          return;
        }
        let result;
        if (request.method === "initialize") {
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "mikiko-fake-native", version: "1" },
          };
        } else if (request.method === "tools/list") {
          await audit({ kind: "native-list" });
          result = { tools };
        } else if (request.method === "tools/call") {
          const { name, arguments: args = {} } = request.params;
          await audit({ kind: "native-call", name, args });
          result =
            name === "query" && args.text === "native-error"
              ? {
                  isError: true,
                  content: [{ type: "text", text: "fixture permission-required" }],
                  structuredContent: { truncated: true, stop_reason: "permission_required" },
                }
              : name === "query" && args.text === "image"
                ? {
                    content: [{ type: "text", text: "fixture truncated query" }, image],
                    structuredContent: {
                      truncated: true,
                      stop_reason: "node_limit",
                      matches: [{ index: 7, role: "AXTextField" }],
                    },
                  }
                : {
                    content: [{ type: "text", text: `native:${name}` }],
                    structuredContent: { fixture: true },
                  };
        } else {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: "fixture method unsupported" },
            }) + "\n",
          );
          return;
        }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      })
      .catch((error) => {
        process.stderr.write(String(error) + "\n");
        process.exitCode = 1;
      });
  });
  input.once("close", () => {
    void requests.then(() => audit({ kind: "native-eof" })).then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void audit({ kind: "native-signal", signal: "SIGTERM" }).then(() => process.exit(0));
  });
}
