import { useEffect, useRef, useState } from "react";
import { createPetAnimator, type ActivePetView } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";

/**
 * 已安装宠物的本地动图预览（specs/desktop/desktop-pet.md）：
 * 经 PetGetInstalledPreview 拿规范化清单 + petpack:// 图集，用共享动画引擎在 canvas 里
 * 循环 idle；hover 时播放 waving 一次（v2 在 idle 间隙偶发 look）。
 * 加载失败时展示占位图标，不阻塞设置页。
 */

export function PetSpritePreview({ petId, className }: { petId: string; className?: string }) {
  const platform = usePlatform();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lookTimer: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      if (timer) clearInterval(timer);
      if (lookTimer) clearInterval(lookTimer);
    };

    void platform
      .petGetInstalledPreview?.(petId)
      .then((view: ActivePetView | null) => {
        if (disposed || !view || !canvasRef.current) {
          if (!view) setFailed(true);
          return;
        }
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) {
          setFailed(true);
          return;
        }
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(canvas.clientWidth * dpr);
        canvas.height = Math.round(canvas.clientHeight * dpr);
        const sheet = new Image();
        sheet.onload = () => {
          if (disposed) return;
          const animator = createPetAnimator(view.pet);
          let lastLookAt = performance.now() + 8_000 + Math.random() * 8_000;
          // 预览容器多为横向（卡片 256×128、当前宠物 160×80），帧是 192×208 竖向；
          // 直接铺满画布会横向拉伸宠物。等比缩放居中绘制，两侧留透明。
          const scale = Math.min(
            canvas.width / view.pet.frameWidth,
            canvas.height / view.pet.frameHeight,
          );
          const drawWidth = view.pet.frameWidth * scale;
          const drawHeight = view.pet.frameHeight * scale;
          const offsetX = (canvas.width - drawWidth) / 2;
          const offsetY = (canvas.height - drawHeight) / 2;
          const draw = () => {
            const spriteIndex = animator.tick(performance.now());
            const column = spriteIndex % view.pet.columns;
            const row = Math.floor(spriteIndex / view.pet.columns);
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(
              sheet,
              column * view.pet.frameWidth,
              row * view.pet.frameHeight,
              view.pet.frameWidth,
              view.pet.frameHeight,
              offsetX,
              offsetY,
              drawWidth,
              drawHeight,
            );
          };
          timer = setInterval(draw, 40);
          lookTimer = setInterval(() => {
            if (animator.current !== "idle" || !view.pet.animations["look"]) return;
            if (performance.now() < lastLookAt) return;
            lastLookAt = performance.now() + 8_000 + Math.random() * 8_000;
            animator.play("look");
          }, 2_000);
          const wave = () => animator.play("waving");
          canvas.addEventListener("mouseenter", wave);
        };
        sheet.onerror = () => setFailed(true);
        sheet.src = view.spritesheetUrl;
      })
      .catch(() => setFailed(true));

    return () => {
      disposed = true;
      cleanup();
    };
  }, [petId, platform]);

  if (failed) {
    return <div className={className} aria-hidden="true" />;
  }
  return <canvas ref={canvasRef} className={className} />;
}
