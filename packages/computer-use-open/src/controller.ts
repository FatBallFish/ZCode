import type { ComputerUseOpenContract, NativeComputerPort, NativeTool } from "./contract.js";
import { exposedParameters, readContext, validateArguments } from "./admission.js";

export function createComputerUseController(
  native: NativeComputerPort,
  options: { allowedApps: string[]; timeoutMs?: number },
): ComputerUseOpenContract {
  const allowed = new Set(options.allowedApps);
  let binding: string | undefined;
  let turn: string | undefined;
  let resetRequired = false;
  const observed = new Map<string, { ax: boolean; screenshot: boolean }>();
  const retiredTurns = new Set<string>();
  let queue = Promise.resolve();
  let closed: Promise<void> | undefined;
  const lifetime = new AbortController();
  const close = () => {
    if (!closed) {
      lifetime.abort();
      observed.clear();
      retiredTurns.clear();
      closed = native.close();
    }
    return closed;
  };
  return {
    async listTools(): Promise<NativeTool[]> {
      if (closed) throw new Error("disposed");
      if (!allowed.size) return [];
      return (await native.listTools())
        .filter((t) => exposedParameters(t.name))
        .map((t) => {
          const properties = Object.fromEntries(
            Object.entries(t.inputSchema.properties ?? {}).filter(([key]) =>
              exposedParameters(t.name).includes(key),
            ),
          );
          properties.app = { type: "string", enum: [...allowed] };
          if (properties.window_placement)
            properties.window_placement = { type: "string", enum: ["keep"] };
          if (properties.key_method) properties.key_method = { type: "string", enum: ["auto"] };
          if (properties.click_method)
            properties.click_method = { type: "string", enum: ["accessibility"] };
          return {
            ...t,
            description: `Mikiko local Computer Use preview: ${t.name}. Requires fresh observation each turn.`,
            inputSchema: {
              ...t.inputSchema,
              properties,
              additionalProperties: false,
              ...(t.name === "click" ? { required: ["app", "element_index"] } : {}),
            },
          };
        });
    },
    call(name, args, meta, signal) {
      const execute = async () => {
        if (closed) throw new Error("disposed");
        if (signal.aborted) throw new Error("cancelled");
        const context = readContext(meta);
        const input = validateArguments(name, args, allowed);
        if (binding && binding !== context.binding) throw new Error("identity-mismatch");
        binding = context.binding;
        if (retiredTurns.has(context.turn)) throw new Error("stale-turn");
        if (turn !== context.turn) {
          observed.clear();
          if (turn) {
            retiredTurns.add(turn);
            resetRequired = true;
          }
          turn = context.turn;
        }
        const observation = name === "get_app_state" || name === "query";
        if (!observation && !observed.has(args.app as string))
          throw new Error("observation-required");
        const state = observed.get(args.app as string);
        if (name === "drag" && !state?.screenshot) throw new Error("screenshot-required");
        if (
          ["click", "set_value", "scroll", "perform_secondary_action", "select_text"].includes(
            name,
          ) &&
          !state?.ax
        ) {
          throw new Error("ax-observation-required");
        }
        const abort = new AbortController();
        const combined = AbortSignal.any([signal, lifetime.signal, abort.signal]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: () => void = () => {};
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error(abort.signal.aborted ? "timeout" : "cancelled"));
          combined.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 30_000);
        });
        try {
          const operation = async () => {
            if (resetRequired) {
              await native.endTurn();
              resetRequired = false;
            }
            combined.throwIfAborted();
            return native.call(name, input, combined);
          };
          const result = await Promise.race([operation(), aborted]);
          if (result.isError) observed.delete(args.app as string);
          // 错误观察不能为后续动作授权；原生返回（含截断、图片和错误）不改写。
          if (name === "get_app_state") {
            observed.delete(args.app as string);
            if (!result.isError)
              observed.set(args.app as string, {
                ax: input.include_ax !== false,
                screenshot:
                  input.include_screenshot !== false &&
                  result.content.some((item) => item.type === "image"),
              });
          }
          return result;
        } catch (error) {
          // 发送后的异常存在副作用不确定性，销毁该连接，不能重试或继续使用旧元素。
          await close();
          throw error;
        } finally {
          clearTimeout(timer);
          combined.removeEventListener("abort", onAbort);
        }
      };
      const pending = queue.then(execute);
      queue = pending.then(
        () => {},
        () => {},
      );
      return pending;
    },
    close,
  };
}
