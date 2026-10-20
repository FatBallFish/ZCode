import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const INTEGRATION_ACCEPTANCE_CASE_NAMES = [
  "conversation-session-integration-worktree-window",
  "conversation-session-integration-composer-stats-voice",
  "conversation-session-integration-skin-remote-entry",
] as const;

/** 在runner清理/重建HOME后、Electron启动前调用，禁止测试App默认连接生产远控。 */
export async function seedIntegrationAcceptanceFixture(input: {
  specs: string[];
  homeDir: string;
}): Promise<void> {
  if (
    !input.specs.some((spec) =>
      INTEGRATION_ACCEPTANCE_CASE_NAMES.some((name) => spec.endsWith(`${name}.test.ts`)),
    )
  )
    return;
  if (!basename(input.homeDir).startsWith(".e2e-home-integration-"))
    throw new Error("Integration acceptance refuses a shared/personal profile");
  const root = join(input.homeDir, ".mikiko");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "remote-control.json"),
    JSON.stringify(
      {
        enabled: false,
        relayWsUrl: "ws://127.0.0.1:9/ws/desktop",
        relayHttpUrl: "http://127.0.0.1:9",
        deviceName: "Mikiko integration fixture",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
