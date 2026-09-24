/**
 * 设置页「跟随左下角当前展示账户」导航意图解析（用户需求 #2，2026-09-24 修订：
 * 跟随源从「会话选中模型的供应商」改为 App 左下角 footer 当前展示的账户）。
 *
 * 目标可能是：中转站（Sub2API）站点 id（footer 展示中转站账号时）、内置
 * Coding Plan 供应商（智谱/Bigmodel）、中转站密钥投影的 personal 供应商、或
 * 普通自定义供应商。除内置 ID 外，到导航节点的映射依赖站点绑定与供应商列表
 * 数据；数据未就绪时返回 pending，由调用方在数据到达后重试，就绪后仍无法
 * 定位才判 invalid——此前非内置 ID 一律被判无效，导航回退到智谱 Coding Plan
 * 侧，表现为「设置页自动切到智谱账户、跟随当前账户不生效」。
 */
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  isStartPlanModelProviderId,
  resolveModelProviderFamilySpecByProviderId,
  type BuiltinModelProviderId,
} from "@zcode/shared";

import type { SettingsModelProviderTarget } from "@/lib/settingsNavigation.js";

export function createPresetProviderNodeKey(id: BuiltinModelProviderId): string {
  return `preset:${id}`;
}

export function createRelayProviderNodeKey(siteId: string): string {
  return `relay:${siteId}`;
}

export function createCodingPlanProviderNodeKey(id: BuiltinModelProviderId): string {
  return `coding-plan:${id}`;
}

export function createCustomProviderNodeKey(id: string): string {
  return `custom:${id}`;
}

export type ModelProviderTargetResolution =
  | { kind: "node"; nodeKey: string }
  /** 供应商/中转站数据尚未加载完成，等调用方依赖变化后重试。 */
  | { kind: "pending" }
  | { kind: "invalid" };

export interface ModelProviderTargetResolutionContext {
  /** 当前已加载的全部供应商 id（内置 + 自定义 + 中转站投影）。 */
  customProviderIds: ReadonlySet<string>;
  /** 中转站密钥绑定的 providerId → siteId。 */
  relayProviderSiteIdByKey: ReadonlyMap<string, string>;
  /** 已知中转站站点 id 集合。 */
  relaySiteIds: ReadonlySet<string>;
  /** 供应商列表与中转站站点均已加载完毕。 */
  navigationReady: boolean;
}

export function resolveBuiltinCodingPlanProviderId(
  providerId: string,
): BuiltinModelProviderId | null {
  switch (providerId) {
    case BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan:
      return providerId;
    default:
      return null;
  }
}

export function resolveProviderFamilySideNodeKey(
  providerId: BuiltinModelProviderId,
): string | null {
  if (isStartPlanModelProviderId(providerId)) return createCodingPlanProviderNodeKey(providerId);
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  return familySpec ? createPresetProviderNodeKey(familySpec.startPlanProviderId) : null;
}

export function resolveModelProviderTargetSelection(
  target: SettingsModelProviderTarget | undefined,
  context: ModelProviderTargetResolutionContext,
): ModelProviderTargetResolution {
  // 站点目标（footer 展示中转站账号时的跟随入口）：直接定位对应站点节点。
  const relaySiteTargetId = target?.relaySiteId?.trim();
  if (relaySiteTargetId) {
    return context.relaySiteIds.has(relaySiteTargetId)
      ? { kind: "node", nodeKey: createRelayProviderNodeKey(relaySiteTargetId) }
      : context.navigationReady
        ? { kind: "invalid" }
        : { kind: "pending" };
  }

  const providerId = target?.providerId?.trim();
  if (!providerId) {
    return { kind: "invalid" };
  }

  const builtinId = resolveBuiltinCodingPlanProviderId(providerId);
  if (builtinId) {
    const nodeKey = resolveProviderFamilySideNodeKey(builtinId);
    return nodeKey ? { kind: "node", nodeKey } : { kind: "invalid" };
  }

  // 中转站密钥供应商：定位到对应站点节点（右侧为该站点的账号与密钥管理）。
  const relaySiteId = context.relayProviderSiteIdByKey.get(providerId);
  if (relaySiteId) {
    return { kind: "node", nodeKey: createRelayProviderNodeKey(relaySiteId) };
  }

  // 普通自定义供应商：定位到「自定义供应商」分组里的对应节点。
  if (context.customProviderIds.has(providerId)) {
    return { kind: "node", nodeKey: createCustomProviderNodeKey(providerId) };
  }

  // 数据未就绪时不判无效——内置 ID 已同步可判，其余两类等列表加载后重试。
  return context.navigationReady ? { kind: "invalid" } : { kind: "pending" };
}
