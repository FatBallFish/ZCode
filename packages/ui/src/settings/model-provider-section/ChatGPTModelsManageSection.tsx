import type { ProviderConfigObject } from "@zcode/provider";
import type { ModelConnectivityResult } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
import { ProviderModelsSection } from "./ProviderCardSections.js";

/**
 * ChatGPT 账号详情的模型管理段（spec §9.2，从 ChatGPTAccountDetailPanel 抽出保持行数预算）：
 * 复用 ProviderModelsSection——同步模型（builtin）支持编辑配置/启停/测试且不可删，
 * 手动添加（personal）模型可删；写入走 ModelProviderSection 注入的 personal 层回调
 * （membership 从 registry 取 builtin slugs，动态 provider 天然可用）。
 */
export interface ChatGPTModelsPanelProvider {
  providerId: string;
  providerName: string;
  enabled: boolean;
  access: ProviderConfigObject["access"];
  models: ProviderSettingsFormModel[];
}

export interface ChatGPTModelsPanelCallbacks {
  onAddPersonalModel: (
    providerId: string,
    modelId: string,
    config: ProviderSettingsFormModel["personalConfig"],
    useRecommendedConfig?: boolean,
  ) => Promise<unknown>;
  onSavePersonalModelDraft: (input: {
    providerId: string;
    originalModelId: string;
    nextModelId: string;
    personalConfig: ProviderSettingsFormModel["personalConfig"];
    useRecommendedConfig?: boolean;
    basedOnRevision: number;
  }) => Promise<unknown>;
  onSetPersonalModelEnabled: (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => Promise<unknown>;
  onDeletePersonalModel: (providerId: string, modelId: string) => Promise<unknown>;
  onReorderProviderModels?: (providerId: string, modelIds: readonly string[]) => Promise<void>;
  onTestModel: (providerId: string, modelId: string) => Promise<ModelConnectivityResult>;
}

export function ChatGPTModelsManageSection({
  modelsPanel,
  callbacks,
  settingsRevision = 0,
}: {
  modelsPanel: ChatGPTModelsPanelProvider;
  callbacks?: ChatGPTModelsPanelCallbacks;
  settingsRevision?: number;
}) {
  const { intl } = useZCodeIntl();
  const actionFailedLabel = intl.formatMessage({
    id: "settings.modelProvider.chatgpt.actionFailed",
  });
  const notifyFailure = (error: unknown) => {
    toast(error instanceof Error ? error.message : actionFailedLabel, { variant: "warning" });
  };

  return (
    <ProviderModelsSection
      providerId={modelsPanel.providerId}
      providerName={modelsPanel.providerName}
      providerEnabled={modelsPanel.enabled}
      providerAccess={modelsPanel.access}
      models={modelsPanel.models}
      onTestModel={
        callbacks?.onTestModel
          ? (modelId) => callbacks.onTestModel(modelsPanel.providerId, modelId)
          : undefined
      }
      onModelCommit={(originalModelId, model, basedOnRevision) =>
        callbacks
          ?.onSavePersonalModelDraft({
            providerId: modelsPanel.providerId,
            originalModelId,
            nextModelId: model.modelId.trim(),
            personalConfig: structuredClone(model.personalConfig),
            ...(model.useRecommendedConfig === undefined
              ? {}
              : { useRecommendedConfig: model.useRecommendedConfig }),
            basedOnRevision,
          })
          .catch(notifyFailure)
          .then(() => undefined) ?? Promise.reject(new Error("unavailable"))
      }
      onModelEnabledChange={(modelId, enabled) => {
        void callbacks
          ?.onSetPersonalModelEnabled(modelsPanel.providerId, modelId, enabled)
          .catch(notifyFailure);
      }}
      onDeleteModel={(modelId) => {
        void callbacks?.onDeletePersonalModel(modelsPanel.providerId, modelId).catch(notifyFailure);
      }}
      onAddModel={(model) =>
        callbacks
          ?.onAddPersonalModel(
            modelsPanel.providerId,
            model.modelId.trim(),
            structuredClone(model.personalConfig),
            model.useRecommendedConfig,
          )
          .then(() => undefined) ?? Promise.reject(new Error("unavailable"))
      }
      onReorderModelIds={(modelIds) => {
        void callbacks?.onReorderProviderModels?.(modelsPanel.providerId, modelIds);
      }}
      settingsRevision={settingsRevision}
    />
  );
}
