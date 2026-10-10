/**
 * 会话框麦克风入口（leading action）—— specs/desktop/voice-input.md §3.2。
 * 桌面限定：平台未提供 voice 能力（Web/远程容器）时不渲染。
 * 状态直接读 voiceInputStore 单例：按钮点亮/转圈与浮窗、快捷键天然一致。
 */
import { memo } from "react";
import { LoaderIcon, MicIcon, MicOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { usePlatform } from "@/hooks/usePlatform.jsx";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { useVoiceInputStore } from "@/voice/voiceInputStore.js";

export const ComposerVoiceInputButton = memo(function ComposerVoiceInputButton({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const shortcutLabel = useShortcutCommandLabel("voiceInput");
  const phase = useVoiceInputStore((state) => state.phase);
  const error = useVoiceInputStore((state) => state.error);
  const toggle = useVoiceInputStore((state) => state.toggle);

  if (!platform.voiceStartSession) return null;

  const listening = phase === "listening";
  const title = error
    ? intl.formatMessage({ id: error.key })
    : listening
      ? intl.formatMessage({ id: "voice.composer.stopTitle" })
      : intl.formatMessage({ id: "voice.composer.startTitle" });

  return (
    <ControlHintTooltip title={title} shortcut={shortcutLabel || undefined}>
      <Button
        type="button"
        variant="ghost"
        size="default"
        data-testid="composer-voice-input-button"
        data-voice-phase={phase}
        aria-label={title}
        aria-pressed={listening}
        disabled={disabled}
        onClick={toggle}
        className={cn(
          "h-7 w-fit justify-center gap-1 rounded-lg px-1.5 py-1.5 text-ui-base",
          "data-[composer-compact=true]:size-7 data-[composer-compact=true]:p-0",
          listening && "text-brand",
        )}
      >
        {phase === "error" ? (
          <MicOffIcon className="size-4 shrink-0 text-destructive" aria-hidden />
        ) : phase === "finishing" || phase === "preparing" ? (
          <LoaderIcon className="size-4 shrink-0 animate-spin" aria-hidden />
        ) : (
          <MicIcon className={cn("size-4 shrink-0", listening && "animate-pulse")} aria-hidden />
        )}
      </Button>
    </ControlHintTooltip>
  );
});
