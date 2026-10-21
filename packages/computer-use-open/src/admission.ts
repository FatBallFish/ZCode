import { isAbsolute } from "node:path";
import { isRemoteWorkspaceIdentity } from "@zcode/shared/workspace-identity";

const parameters: Record<string, string[]> = {
  get_app_state: [
    "app",
    "include_ax",
    "include_screenshot",
    "text_limit",
    "max_tree_nodes",
    "max_tree_depth",
    "window_placement",
  ],
  query: ["app", "text", "role", "exact", "limit", "max_nodes", "window_id"],
  click: ["app", "element_index", "click_count", "mouse_button", "click_method"],
  perform_secondary_action: ["app", "element_index", "action"],
  scroll: ["app", "element_index", "direction", "pages"],
  drag: ["app", "from_x", "from_y", "to_x", "to_y"],
  type_text: ["app", "text", "key_method"],
  press_key: ["app", "key", "key_method"],
  set_value: ["app", "element_index", "value"],
  select_text: ["app", "element_index", "text", "prefix", "suffix", "selection"],
};

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function nonempty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readContext(meta: unknown, production = false) {
  const context = record(record(meta)["com.zcode/request-context"]);
  const session = nonempty(context.session_id);
  const turn = nonempty(context.turn_id);
  const path = nonempty(context.workspace_path);
  const identity = nonempty(context.workspace_identity);
  const workspace = identity || path;
  // 不能从模型参数、子会话命名或缺失字段推断可信本地上下文。
  if (
    context.runtime_scope !== "main" ||
    !session ||
    !turn ||
    !workspace ||
    !isAbsolute(path) ||
    (identity && (production ? isRemoteWorkspaceIdentity(identity) : identity !== path)) ||
    context.client_mode !== "desktop-continuous" ||
    context.delivery_kind !== "desktop-continuous" ||
    nonempty(context.remote_session_id)
  )
    throw new Error("scope-denied: local main desktop context required");
  if (nonempty(context.workspace_key) && nonempty(context.workspace_key) !== workspace) {
    throw new Error("scope-denied: inconsistent workspace identity");
  }
  return { binding: JSON.stringify([session, workspace]), turn };
}

export function validateArguments(
  name: string,
  args: Record<string, unknown>,
  allowed: Set<string> | undefined,
) {
  if (!Object.hasOwn(parameters, name)) throw new Error("tool-denied: unavailable preview tool");
  if (
    typeof args.app !== "string" ||
    (allowed
      ? !allowed.has(args.app)
      : !/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/.test(args.app))
  )
    throw new Error("target-denied: app must be explicitly allowed");
  if (Object.keys(args).some((key) => !parameters[name].includes(key)))
    throw new Error("parameter-denied: unsupported argument");
  if (
    (args.window_placement !== undefined && args.window_placement !== "keep") ||
    (args.key_method !== undefined && args.key_method !== "auto") ||
    (args.click_method !== undefined && args.click_method !== "accessibility")
  ) {
    throw new Error("mode-denied: global, sky and virtual display modes are unavailable");
  }
  if (name === "click" && (typeof args.element_index !== "string" || !args.element_index)) {
    throw new Error("parameter-denied: preview click requires AX element_index");
  }
  return name === "click" ? { ...args, click_method: "accessibility" } : args;
}

export function exposedParameters(name: string) {
  return parameters[name];
}
