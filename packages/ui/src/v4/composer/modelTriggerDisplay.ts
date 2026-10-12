import {
  BUILTIN_MODEL_PROVIDER_IDS,
  isChatGPTAccountProviderId,
  resolveModelProviderFamilyIdByProviderId,
} from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";

export interface V4ModelTriggerDisplay {
  fullLabel: string;
  modelLabel: string;
  providerPrefix?: string;
}

/**
 * 是否为「固定入口型」供应商：trigger 与切换文案只显示模型名。
 * zai/bigmodel family 是产品固定入口；ChatGPT 账号 provider 的 providerId 含动态
 * accountId，拼前缀会露出 account:chatgpt:{uuid} 长串（会话恢复时 providerName 缺失
 * 更是直接回退 providerId），与新建会话的表现不一致，统一按模型名展示。
 */
function isFixedEntryProviderId(providerId: string | undefined): boolean {
  if (!providerId) return false;
  return (
    resolveModelProviderFamilyIdByProviderId(providerId) !== null ||
    isChatGPTAccountProviderId(providerId)
  );
}

export function formatModelChangeLabel(
  providerId: string | undefined,
  providerName: string | undefined,
  modelName: string,
  intl: Pick<IntlInstance, "formatMessage">,
): string {
  let planLabelId: string;
  // 切换记录必须保留当时的套餐身份，不能从当前连接或可用模型目录反推历史套餐。
  switch (providerId) {
    case BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan:
      planLabelId = "settings.modelProvider.connectionMode.codingPlan";
      break;
    case BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan:
      planLabelId = "settings.modelProvider.connectionMode.startPlan";
      break;
    case BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan:
      planLabelId = "settings.modelProvider.connectionMode.teamPlan";
      break;
    default:
      return formatProviderModelLabel(providerId, providerName, modelName);
  }
  return `${modelName}(${intl.formatMessage({ id: planLabelId })})`;
}

export function formatProviderModelLabel(
  providerId: string | undefined,
  providerName: string | undefined,
  modelName: string,
): string {
  // Z.ai / BigModel 的内置连接名属于产品固定入口，拼进模型文案会重复展示
  // “Coding Plan”等连接信息；切换提示额外通过 formatModelChangeLabel 标明套餐类型。
  // ChatGPT 账号 provider 同为固定入口（见 isFixedEntryProviderId 注释）。
  if (isFixedEntryProviderId(providerId)) {
    return modelName;
  }

  const normalizedProviderName = providerName?.trim();
  return normalizedProviderName ? `${normalizedProviderName}/${modelName}` : modelName;
}

export function resolveV4ModelTriggerLabel({
  modelGroups,
  normalizedValue,
  fallbackLabel,
  providerId,
  providerName,
}: {
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  fallbackLabel: string;
  providerId: string | undefined;
  providerName?: string;
}): string {
  const selectedGroup = modelGroups.find((group) =>
    group.items.some((item) => item.value === normalizedValue),
  );
  const selectedItem = selectedGroup?.items.find((item) => item.value === normalizedValue);
  if (!selectedGroup || !selectedItem) {
    return fallbackLabel;
  }

  // 仅当前菜单中存在的连接按 ID 兜底；历史记录的通用格式化保留原有语义。
  return formatProviderModelLabel(
    providerId,
    providerName?.trim() || providerId,
    selectedItem.name,
  );
}

export function resolveV4ModelTriggerDisplay({
  modelGroups,
  normalizedValue,
  fallbackLabel,
  providerId,
  providerName,
}: {
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  fallbackLabel: string;
  providerId: string | undefined;
  providerName?: string;
}): V4ModelTriggerDisplay {
  // 把 provider/model 预先拼成单一字符串后，响应式布局只能整段隐藏或依赖
  // 平台 JS 分支裁剪；这里保留结构化前缀，让 composer 容器断点统一决定可见密度。
  const fullLabel = resolveV4ModelTriggerLabel({
    modelGroups,
    normalizedValue,
    fallbackLabel,
    providerId,
    providerName,
  });
  const selectedGroup = modelGroups.find((group) =>
    group.items.some((item) => item.value === normalizedValue),
  );
  const selectedItem = selectedGroup?.items.find((item) => item.value === normalizedValue);
  if (!selectedGroup || !selectedItem) {
    return { fullLabel, modelLabel: fallbackLabel };
  }

  const modelLabel = selectedItem.name;
  const normalizedProviderName = providerName?.trim() || providerId;
  if (!normalizedProviderName || isFixedEntryProviderId(providerId)) {
    return { fullLabel, modelLabel };
  }

  return {
    fullLabel,
    providerPrefix: `${normalizedProviderName}/`,
    modelLabel,
  };
}
