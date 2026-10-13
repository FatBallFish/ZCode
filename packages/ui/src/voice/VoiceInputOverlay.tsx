/**
 * 语音输入浮窗 —— specs/desktop/voice-input.md §3.2。
 * 底部居中的无边框浮层：监听波浪动效 + 实时识别文案 + 状态行 + 关闭按钮；
 * ESC / 关闭按钮取消本次输入。App 级单例挂载（fixed 定位，锚定 composer 上方）。
 */
import { memo, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { LoaderIcon, MicIcon, XIcon } from "lucide-react";
import { TID_V4_COMPOSER } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { usePlatform } from "@/hooks/usePlatform.jsx";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useVoiceInputStore } from "@/voice/voiceInputStore.js";

const WAVE_BARS = 24;
/** 静音判定阈值（RMS）：低于该值视为无声，音条回落到贴底静止、无波纹。 */
const WAVE_SILENCE_LEVEL = 0.02;
/**
 * RMS → 视觉高度的映射（2026-10-14 自测反馈：线性映射下典型语音 RMS 0.02-0.15
 * 只产生 <10% 的 scaleY 差异，几乎看不出音量变化）。用幂函数（指数 0.6）扩展
 * 低量程动态范围：0.02→0.09、0.05→0.17、0.1→0.25、0.3→0.49——安静说话与大声
 * 说话的区别肉眼可见。人声 RMS 超 0.5 极罕见，>0.5 饱和到 1。
 */
function rmsToVisualLevel(rms: number): number {
  return Math.min(1, Math.pow(rms, 0.6));
}
/** 音条静态高度（index 推导，确定性：同一渲染会话内不闪烁跳变）。 */
function waveBarHeightPercent(index: number): number {
  return 22 + ((index * 29) % 9) * 7;
}

export const VoiceInputOverlay = memo(function VoiceInputOverlay() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const phase = useVoiceInputStore((state) => state.phase);
  const partialText = useVoiceInputStore((state) => state.partialText);
  const downloadProgress = useVoiceInputStore((state) => state.downloadProgress);
  const engineLoading = useVoiceInputStore((state) => state.engineLoading);
  const finishingStage = useVoiceInputStore((state) => state.finishingStage);
  const error = useVoiceInputStore((state) => state.error);
  const cancel = useVoiceInputStore((state) => state.cancel);

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const prefersReducedMotion = useReducedMotion();
  const waveBarsRef = useRef<Array<HTMLSpanElement | null>>([]);

  // 真实音量驱动的音浪：worklet 每 100ms 帧附带 RMS 写入 store，rAF 读取做
  // attack/decay 包络 + 相位交错的摆动；无声（低于阈值）回落贴底静止、无波纹。
  // 直接操作 DOM 避免 60Hz setState 重渲整卡。
  useEffect(() => {
    const resetBars = () => {
      for (const bar of waveBarsRef.current) {
        if (bar) bar.style.transform = "scaleY(0.35)";
      }
    };
    if (phase !== "listening" || prefersReducedMotion) {
      resetBars();
      return;
    }
    let envelope = 0;
    let raf = 0;
    const loop = () => {
      // RMS 经幂函数映射后再做包络——线性 RMS 在典型语音量程内视觉差异 <10%。
      const target = rmsToVisualLevel(useVoiceInputStore.getState().audioLevel);
      envelope += (target - envelope) * (target > envelope ? 0.55 : 0.12);
      const speaking = envelope > WAVE_SILENCE_LEVEL;
      const now = performance.now();
      const bars = waveBarsRef.current;
      for (let index = 0; index < bars.length; index++) {
        const bar = bars[index];
        if (!bar) continue;
        const sway = speaking ? 0.5 + 0.5 * Math.sin(now / 130 + index * 0.85) : 0;
        const scale = speaking ? 0.12 + envelope * 0.88 * (0.55 + 0.45 * sway) : 0.08;
        bar.style.transform = `scaleY(${Math.min(1, scale).toFixed(3)})`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      resetBars();
    };
  }, [phase, prefersReducedMotion]);

  // 转录文本自动滚动到底部。
  useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [partialText]);

  const visible = phase !== "idle";

  // 锚定 composer 顶边之上：bottom dock 在 composer 下方还有建议 chips 行，
  // 固定 bottom-36 会压住快捷操作区（真机 E2E 实测）；找不到 composer 时回退 bottom-36。
  const [anchorBottomPx, setAnchorBottomPx] = useState<number | null>(null);
  useEffect(() => {
    if (!visible) return;
    const updateAnchor = () => {
      const composer = document.querySelector(`[data-testid="${TID_V4_COMPOSER}"]`);
      if (!(composer instanceof HTMLElement)) {
        setAnchorBottomPx(null);
        return;
      }
      const top = composer.getBoundingClientRect().top;
      setAnchorBottomPx(Math.max(window.innerHeight - top + 12, 16));
    };
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    return () => window.removeEventListener("resize", updateAnchor);
  }, [visible]);

  // ESC 取消（capture：先于 composer 的 ESC 处理；录制快捷键态由 useAppKeyboard 统一抑制）。
  useEffect(() => {
    if (phase !== "preparing" && phase !== "listening" && phase !== "error") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 对话框/弹层打开时 ESC 属于它们（关闭弹层而不是取消录音）。
      // target 可能是非 Element（如合成事件落在 window 上）：closest 不存在时视作无弹层。
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('[role="dialog"], [data-radix-popper-content-wrapper]')
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [phase, cancel]);

  let statusText: string;
  if (phase === "preparing") {
    if (downloadProgress) {
      const percent = Math.floor(
        (downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100,
      );
      statusText = intl.formatMessage(
        { id: "voice.overlay.status.downloading" },
        { file: downloadProgress.activeFile, percent },
      );
    } else if (engineLoading) {
      statusText = intl.formatMessage({
        id: "voice.overlay.status.engineLoading",
      });
    } else {
      statusText = intl.formatMessage({ id: "voice.overlay.status.preparing" });
    }
  } else if (phase === "listening") {
    statusText = intl.formatMessage({ id: "voice.overlay.status.listening" });
  } else if (phase === "finishing") {
    statusText = intl.formatMessage({
      id:
        finishingStage === "cleanup"
          ? "voice.overlay.status.cleanup"
          : "voice.overlay.status.transcribing",
    });
  } else {
    statusText = error
      ? intl.formatMessage({ id: error.key }) + (error.detail ? `：${error.detail}` : "")
      : "";
  }

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key="voice-input-overlay"
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.98 }}
          animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
          transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
          data-testid="voice-input-overlay"
          data-voice-phase={phase}
          style={anchorBottomPx != null ? { bottom: anchorBottomPx } : undefined}
          className="pointer-events-auto fixed bottom-36 left-1/2 z-40 w-[min(560px,calc(100vw-32px))] -translate-x-1/2"
        >
          <div
            className={cn(
              "rounded-2xl border border-border bg-bg-elevated/95 p-3 shadow-xl backdrop-blur",
              phase === "error" ? "border-destructive/40" : "",
            )}
          >
            <div className="flex items-center gap-3">
              {phase === "finishing" ? (
                <LoaderIcon className="size-4 shrink-0 animate-spin text-fg-subtle" aria-hidden />
              ) : (
                <MicIcon
                  className={cn(
                    "size-4 shrink-0",
                    phase === "listening" ? "text-brand" : "text-fg-subtle",
                  )}
                  aria-hidden
                />
              )}
              <span
                className="min-w-0 flex-1 truncate text-ui-sm text-fg-subtle"
                data-testid="voice-input-overlay-status"
              >
                {statusText}
              </span>
              {phase === "error" && error?.key === "voice.error.micDenied" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="shrink-0"
                  onClick={async () => {
                    const result = await platform
                      .voiceOpenMicPermissionSettings?.()
                      .catch(() => null);
                    // macOS 补请求流程里用户直接点了“允许”：错误已解除，浮窗随消隐。
                    if (result?.status === "granted") cancel();
                  }}
                >
                  {intl.formatMessage({ id: "voice.overlay.openMicSettings" })}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                aria-label={intl.formatMessage({ id: "voice.overlay.close" })}
                data-testid="voice-input-overlay-close"
                onClick={cancel}
                className="size-6 shrink-0"
              >
                <XIcon className="size-4" aria-hidden />
              </Button>
            </div>

            {/* 监听音浪：真实 RMS 电平驱动（无声无波纹）；reduced motion 退化为静态音条。 */}
            <div className="mt-2 flex h-8 items-center justify-center gap-[3px]" aria-hidden>
              {Array.from({ length: WAVE_BARS }, (_, index) =>
                prefersReducedMotion ? (
                  <span
                    key={index}
                    className="w-[3px] rounded-full bg-brand/50"
                    style={{ height: `${waveBarHeightPercent(index)}%` }}
                  />
                ) : (
                  <span
                    key={index}
                    ref={(node) => {
                      waveBarsRef.current[index] = node;
                    }}
                    className="w-[3px] origin-center rounded-full bg-brand/60"
                    style={{
                      height: `${waveBarHeightPercent(index)}%`,
                      transform: "scaleY(0.35)",
                    }}
                  />
                ),
              )}
            </div>

            {(phase === "listening" || phase === "finishing") && partialText.length > 0 ? (
              <div
                ref={transcriptRef}
                data-testid="voice-input-overlay-transcript"
                className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-bg-base/60 px-3 py-2 text-ui-base text-fg"
              >
                {partialText}
              </div>
            ) : null}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
});
