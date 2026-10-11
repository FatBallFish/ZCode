/**
 * 语音识别模型卡列表（specs/desktop/voice-input.md §3.1）——从 VoiceInputSettingsSection
 * 拆出（该分区加入输入设备/权限行后超 max-lines）。纯展示：状态与操作经 props 传入。
 */
import { CheckCircle2Icon, CircleIcon, DownloadIcon, LoaderIcon, Trash2Icon } from "lucide-react";
import { VOICE_MODEL_MANIFESTS, type VoiceStateSnapshot } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`;
}

export function VoiceModelCardList({
  snapshot,
  selectedModelId,
  onSelect,
  onDownload,
  onDelete,
}: {
  snapshot: VoiceStateSnapshot | null;
  selectedModelId: string;
  onSelect: (modelId: string) => void;
  onDownload: (modelId: string) => void;
  onDelete: (modelId: string) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <>
      {snapshot?.supported === false ? (
        <SettingsRow
          label={intl.formatMessage({ id: "settings.voiceInput.unsupported.title" })}
          description={
            snapshot.unsupportedReason ??
            intl.formatMessage({ id: "settings.voiceInput.unsupported.description" })
          }
          control={<span aria-hidden="true" />}
        />
      ) : null}
      {/* 分割线用 --color-border（与 SettingsRow 一致）。divide-border-subtle 的 token
          并不存在，生成不出颜色会回退 currentColor（文字色≈纯黑，真机反馈）。 */}
      <div className="divide-y divide-border">
        {VOICE_MODEL_MANIFESTS.map((manifest) => {
          const install = snapshot?.models.find((entry) => entry.modelId === manifest.id)?.install;
          const status = install?.status ?? "not-installed";
          const downloading = install?.status === "downloading" ? install : null;
          const isSelected = selectedModelId === manifest.id;
          return (
            <div
              key={manifest.id}
              data-testid={`voice-model-card-${manifest.id}`}
              data-install-state={status}
              className="flex flex-col gap-2 px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label={intl.formatMessage({ id: "settings.voiceInput.model.select" })}
                  data-select-model-id={manifest.id}
                  disabled={status !== "installed"}
                  onClick={() => onSelect(manifest.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  {isSelected ? (
                    <CheckCircle2Icon className="size-4 shrink-0 text-brand" aria-hidden />
                  ) : (
                    <CircleIcon
                      className={cn(
                        "size-4 shrink-0",
                        status === "installed" ? "text-fg-subtle" : "text-fg-subtlest",
                      )}
                      aria-hidden
                    />
                  )}
                  <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
                    {intl.formatMessage({ id: manifest.labelKey })}
                  </span>
                  <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-ui-xs text-fg-subtle">
                    {intl.formatMessage({
                      id: `settings.voiceInput.model.${manifest.id}.tag`,
                    })}
                  </span>
                </button>
                {downloading ? (
                  <Button type="button" variant="ghost" size="xs" disabled>
                    <LoaderIcon className="size-4 animate-spin" aria-hidden />
                    {`${Math.floor((downloading.receivedBytes / downloading.totalBytes) * 100)}%`}
                  </Button>
                ) : status === "installed" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={intl.formatMessage({ id: "settings.voiceInput.model.delete" })}
                    onClick={() => onDelete(manifest.id)}
                  >
                    <Trash2Icon className="size-4" aria-hidden />
                  </Button>
                ) : status === "error" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => onDownload(manifest.id)}
                  >
                    {intl.formatMessage({ id: "settings.voiceInput.download.retry" })}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => onDownload(manifest.id)}
                  >
                    <DownloadIcon className="size-4" aria-hidden />
                    {intl.formatMessage({ id: "settings.voiceInput.download.action" })}
                  </Button>
                )}
              </div>
              <div className="pl-6 text-ui-sm text-fg-subtle">
                {intl.formatMessage({
                  id: `settings.voiceInput.model.${manifest.id}.description`,
                })}
                <span className="ml-1 text-fg-subtlest">
                  {intl.formatMessage({
                    id: `settings.voiceInput.model.${manifest.id}.license`,
                  })}
                </span>
              </div>
              <div className="pl-6 flex flex-wrap gap-x-4 gap-y-1 text-ui-xs text-fg-subtlest">
                <span>
                  {intl.formatMessage({ id: "settings.voiceInput.model.disk" })}
                  {formatMb(manifest.approxDiskMb)}
                </span>
                <span>
                  {intl.formatMessage({ id: "settings.voiceInput.model.memory" })}
                  {formatMb(manifest.approxRuntimeMemMb[0])}–
                  {formatMb(manifest.approxRuntimeMemMb[1])}
                </span>
                <span>
                  {intl.formatMessage({
                    id: manifest.streaming
                      ? "settings.voiceInput.model.streaming"
                      : "settings.voiceInput.model.segmented",
                  })}
                </span>
                {downloading ? (
                  <span className="text-brand">
                    {intl.formatMessage(
                      { id: "settings.voiceInput.download.progress" },
                      {
                        file: downloading.activeFile,
                        percent: Math.floor(
                          (downloading.receivedBytes / downloading.totalBytes) * 100,
                        ),
                      },
                    )}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
