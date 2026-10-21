/**
 * computer-use-open 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { ComputerUseOpenContract } from "./contract.js";

export async function observeFixture(contract: ComputerUseOpenContract, workspacePath: string) {
  return contract.call(
    "get_app_state",
    { app: "dev.mikiko.computer-use.fixture" },
    {
      "com.zcode/request-context": {
        runtime_scope: "main",
        session_id: "fixture-session",
        turn_id: "turn-1",
        workspace_path: workspacePath,
        client_mode: "desktop-continuous",
        delivery_kind: "desktop-continuous",
      },
    },
    new AbortController().signal,
  );
}
