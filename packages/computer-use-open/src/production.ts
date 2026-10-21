import type { ComputerUseOpenContract, NativeComputerPort, NativeTool } from "./contract.js";
import { createComputerUseController } from "./controller.js";

const stopTool: NativeTool = {
  name: "stop",
  description:
    "Stop this session's Computer Use and release its native control lease. A fresh observation is required before further actions.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

/** Session/workspace owner stays bound across stop; only its native connection rotates. */
export function createProductionComputerUseController(
  factory: () => NativeComputerPort,
): ComputerUseOpenContract {
  let current: NativeComputerPort | undefined;
  let disposed = false;
  const probes = new Set<NativeComputerPort>();
  const closures = new WeakMap<NativeComputerPort, Promise<void>>();
  const closePort = (port: NativeComputerPort) => {
    let closing = closures.get(port);
    if (!closing) {
      closing = Promise.resolve().then(() => port.close());
      closures.set(port, closing);
    }
    return closing;
  };
  async function readProbe<T>(operation: (port: NativeComputerPort) => Promise<T>): Promise<T> {
    if (disposed) throw new Error("disposed");
    const port = factory();
    probes.add(port);
    try {
      const result = await operation(port);
      if (disposed) throw new Error("disposed");
      return result;
    } finally {
      probes.delete(port);
      await closePort(port);
    }
  }
  const native = () => {
    if (disposed) throw new Error("disposed");
    return (current ??= factory());
  };
  const controller = createComputerUseController(
    {
      // 发现不保留原生连接，避免空闲权限重启使后续首次动作拿到已断开的旧client。
      listTools: () => readProbe((port) => port.listTools()),
      call: (name, args, signal) =>
        name === "list_apps"
          ? readProbe((port) => port.call(name, args, signal))
          : native().call(name, args, signal),
      async endTurn() {
        // 原生元素缓存属于本连接，回合结束后关闭连接，不能跨回合复用截图/AX authority。
        const previous = current;
        current = undefined;
        if (previous) {
          try {
            await previous.endTurn();
          } finally {
            await closePort(previous);
          }
        }
      },
      async close() {
        disposed = true;
        const previous = current;
        current = undefined;
        const owned = [...probes, ...(previous ? [previous] : [])];
        probes.clear();
        await Promise.all(owned.map(closePort));
      },
    },
    { allowedApps: [], production: true },
  );
  return {
    ...controller,
    async listTools() {
      return [...(await controller.listTools()), stopTool];
    },
  };
}
