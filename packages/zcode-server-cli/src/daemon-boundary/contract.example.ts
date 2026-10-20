import { createUpdateDaemonHandoff, type UpdateHandoffProcessBoundary } from "./contract.js";

/** 可注入进程边界做隔离验证；生产环境省略端口时使用既有真实 daemon 操作。 */
export async function example(
  input: Parameters<ReturnType<typeof createUpdateDaemonHandoff>["converge"]>[0],
  processBoundary: UpdateHandoffProcessBoundary,
): Promise<void> {
  await createUpdateDaemonHandoff(processBoundary).converge(input);
}
