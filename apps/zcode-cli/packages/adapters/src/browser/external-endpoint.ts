export interface ExternalCdpOptions {
  endpoint: string;
  name?: string;
  expectedBrowserId?: string;
}

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16_384;
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|\[::1\]):[0-9]+\/?$/;

export function validateExternalEndpoint(value: string): URL {
  if (!LOOPBACK_ORIGIN.test(value))
    throw new Error("External CDP requires a literal loopback HTTP origin.");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("External CDP requires an explicit loopback HTTP origin without credentials.");
  }
  return url;
}

export async function resolveExternalEndpoint(
  endpoint: string,
  expectedBrowserId?: string,
): Promise<{ websocket: string; browserId: string }> {
  const origin = validateExternalEndpoint(endpoint);
  const response = await fetch(new URL("/json/version", origin), {
    redirect: "error",
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("External CDP version handshake failed.");
  if (!response.body) throw new Error("External CDP version response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("External CDP version response is too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const version = JSON.parse(text) as Record<string, unknown>;
  if (typeof version.Browser !== "string" || !/^(Chrome|Chromium)\//.test(version.Browser)) {
    throw new Error("External CDP endpoint is not a Chromium browser.");
  }
  if (typeof version.webSocketDebuggerUrl !== "string") {
    throw new Error("External CDP endpoint has no browser WebSocket.");
  }
  const websocket = new URL(version.webSocketDebuggerUrl);
  const match = /^\/devtools\/browser\/([a-zA-Z0-9-]+)$/.exec(websocket.pathname);
  if (
    websocket.protocol !== "ws:" ||
    websocket.hostname !== origin.hostname ||
    websocket.port !== origin.port ||
    websocket.username ||
    websocket.password ||
    websocket.search ||
    websocket.hash ||
    !match
  ) {
    throw new Error("External CDP WebSocket must belong to the configured loopback origin.");
  }
  const browserId = match[1]!;
  if (expectedBrowserId && expectedBrowserId !== browserId) {
    throw new Error("External CDP browser identity changed; explicit rebinding is required.");
  }
  return { websocket: websocket.href, browserId };
}

export function parseExternalCdpOptions(value: string): ExternalCdpOptions {
  const input: unknown = JSON.parse(value);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid external CDP configuration.");
  const config = input as Record<string, unknown>;
  if (
    Object.keys(config).some((key) => !["endpoint", "name", "expectedBrowserId"].includes(key)) ||
    typeof config.endpoint !== "string" ||
    (config.name !== undefined && (typeof config.name !== "string" || !config.name.trim())) ||
    (config.expectedBrowserId !== undefined &&
      (typeof config.expectedBrowserId !== "string" ||
        !/^[a-zA-Z0-9-]+$/.test(config.expectedBrowserId)))
  ) {
    throw new Error("Invalid external CDP configuration.");
  }
  validateExternalEndpoint(config.endpoint);
  return config as unknown as ExternalCdpOptions;
}
