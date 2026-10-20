import { appendFile } from "node:fs/promises";

const generation = Number(process.argv[2] ?? 0);
const outputPath = process.env.ZCODE_TEST_WIRING_OUTPUT;
if (!outputPath) throw new Error("ZCODE_TEST_WIRING_OUTPUT is required");

await appendFile(
  outputPath,
  `${JSON.stringify({
    agentArgs: JSON.parse(process.env.MIKIKO_AGENT_SERVER_ARGS_JSON ?? "[]"),
    agentCommand: process.env.MIKIKO_AGENT_SERVER_COMMAND ?? null,
    dataBaseDir: process.env.MIKIKO_DATA_BASE_DIR ?? null,
    generation,
    runtimeRoot: process.env.MIKIKO_SERVER_RUNTIME_ROOT ?? null,
  })}\n`,
  "utf8",
);

process.send?.({
  type: "ready",
  host: "127.0.0.1",
  port: 43123 + generation,
  version: process.env.ZCODE_TEST_CORE_VERSION ?? "fixture",
  ...(process.env.MIKIKO_SERVER_RELEASE_ID
    ? { releaseId: process.env.MIKIKO_SERVER_RELEASE_ID }
    : {}),
  generation,
});

process.on("message", (message) => {
  if (typeof message === "object" && message !== null && message.command === "shutdown") {
    process.send?.({ type: "shutdown-ack" });
    process.send?.({ type: "exit", reason: "requested" }, () => process.exit(0));
  }
});
