import type { ActivePetView } from "@zcode/shared";
import { createPetAnimator, dragAnimationName } from "@zcode/shared";

/**
 * 宠物窗口页面（vanilla，无 React）：canvas 逐帧绘制 petpack:// 图集；
 * 拖拽经 preload 增量上报 main；点击播放 waving；右键弹 main 菜单。
 * 交互细节：pointerdown→pointerup 位移小于阈值视为点击；拖拽中按方向切换跑动动作。
 */

interface DesktopPetBridge {
  getActive(): Promise<{
    view: ActivePetView;
    state: "idle" | "running" | "waiting" | "failed" | "review";
  } | null>;
  dragMove(delta: { dx: number; dy: number }): void;
  contextMenu(): void;
  openApp(): void;
  onState(
    callback: (event: {
      state: "idle" | "running" | "waiting" | "failed" | "review" | "waving";
    }) => void,
  ): () => void;
}

declare global {
  interface Window {
    desktopPet?: DesktopPetBridge;
  }
}

const FRAME_ANIMATION_INTERVAL_MS = 16;
const CLICK_THRESHOLD_PX = 6;
const LOOK_INTERVAL_MIN_MS = 20_000;
const LOOK_INTERVAL_JITTER_MS = 20_000;

const bridge = window.desktopPet;
const canvas = document.getElementById("stage") as HTMLCanvasElement | null;

interface DragSession {
  pointerId: number;
  lastScreenX: number;
  lastScreenY: number;
  movedPx: number;
  lastDirectionAt: number;
  lastDirection: string | undefined;
  pendingDirection: string | undefined;
  pendingDistancePx: number;
}

async function main() {
  if (!bridge || !canvas) return;
  const active = await bridge.getActive();
  if (!active) return;
  const { pet, spritesheetUrl } = active.view;

  const context = canvas.getContext("2d");
  if (!context) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);

  const sheet = new Image();
  sheet.src = spritesheetUrl;
  await new Promise((resolve, reject) => {
    sheet.onload = resolve;
    sheet.onerror = reject;
  }).catch(() => undefined);
  if (!sheet.naturalWidth) return;

  const animator = createPetAnimator(pet, active.state);
  let dragging: DragSession | undefined;
  let lastClickAt = 0;
  let lastLookAt =
    performance.now() + LOOK_INTERVAL_MIN_MS + Math.random() * LOOK_INTERVAL_JITTER_MS;

  const draw = () => {
    const spriteIndex = animator.tick(performance.now());
    const column = spriteIndex % pet.columns;
    const row = Math.floor(spriteIndex / pet.columns);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      sheet,
      column * pet.frameWidth,
      row * pet.frameHeight,
      pet.frameWidth,
      pet.frameHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  };
  const loop = setInterval(draw, FRAME_ANIMATION_INTERVAL_MS);

  // v2 环视：idle 态偶发播放 look（一次性，播完自动回 idle）。
  const maybeLook = () => {
    if (dragging || animator.current !== "idle" || !pet.animations["look"]) return;
    if (performance.now() < lastLookAt) return;
    lastLookAt = performance.now() + LOOK_INTERVAL_MIN_MS + Math.random() * LOOK_INTERVAL_JITTER_MS;
    animator.play("look");
  };
  const lookLoop = setInterval(maybeLook, 2000);

  // 最近一次 main 下发的稳态（idle/running/waiting/failed/review）：一次性动作
  // （挥手/环视）播完后回到它，而不是滞留 idle——否则会话运行中点一下宠物就一直 idle。
  let lastSteadyState: "idle" | "running" | "waiting" | "failed" | "review" = active.state;
  let steadyRestoreTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSteadyRestore = (delayMs: number) => {
    if (steadyRestoreTimer) clearTimeout(steadyRestoreTimer);
    steadyRestoreTimer = setTimeout(() => {
      steadyRestoreTimer = undefined;
      if (!dragging) animator.play(lastSteadyState);
    }, delayMs);
  };

  const disposeState = bridge.onState((event) => {
    if (dragging) return;
    if (event.state === "waving") {
      animator.play("waving");
      // waving 是主序列×3（4 帧 ×3 遍），约 2.8s；3.2s 后回稳态。
      scheduleSteadyRestore(3200);
      return;
    }
    lastSteadyState = event.state;
    animator.play(event.state);
  });

  canvas.addEventListener("pointerdown", (event) => {
    // 只有主键（左键）可以开始拖拽：右键按下会弹菜单，菜单吞掉 pointerup，
    // 拖拽会话悬空表现为"宠物一直跟着鼠标走，直到再点一次左键"。
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    dragging = {
      pointerId: event.pointerId,
      lastScreenX: event.screenX,
      lastScreenY: event.screenY,
      movedPx: 0,
      lastDirectionAt: 0,
      lastDirection: undefined,
      pendingDirection: undefined,
      pendingDistancePx: 0,
    };
    document.body.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    // 增量必须用屏幕全局坐标：窗口本身随鼠标移动，视口坐标（clientX/Y）下鼠标
    // 位置几乎不变，宠物只能靠事件残差推进（跟不上鼠标 + 残差噪声抖动方向）。
    // screenX/Y 与 main setPosition 同为全局 DIP 坐标系，逐事件增量即真实鼠标位移。
    const dx = event.screenX - dragging.lastScreenX;
    const dy = event.screenY - dragging.lastScreenY;
    dragging.lastScreenX = event.screenX;
    dragging.lastScreenY = event.screenY;
    if (dx === 0 && dy === 0) return;
    const step = Math.hypot(dx, dy);
    dragging.movedPx += step;
    bridge.dragMove({ dx, dy });
    if (dragging.movedPx > CLICK_THRESHOLD_PX) {
      // 方向切换带迟滞：新方向累计 ≥16px（或单次 ≥20px 快速甩动）且距上次切换
      // ≥200ms 才切动画；斜向漂移/手抖不会在左右动画间来回闪。
      const direction = dragAnimationName(dx, dy);
      if (direction === dragging.lastDirection) {
        dragging.pendingDirection = undefined;
        dragging.pendingDistancePx = 0;
      } else {
        if (direction === dragging.pendingDirection) {
          dragging.pendingDistancePx += step;
        } else {
          dragging.pendingDirection = direction;
          dragging.pendingDistancePx = step;
        }
        const now = performance.now();
        if (
          (dragging.pendingDistancePx >= 16 || step >= 20) &&
          now - dragging.lastDirectionAt >= 200
        ) {
          dragging.lastDirection = direction;
          dragging.lastDirectionAt = now;
          dragging.pendingDirection = undefined;
          dragging.pendingDistancePx = 0;
          animator.play(direction);
        }
      }
    }
  });
  const endDrag = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const wasClick = dragging.movedPx <= CLICK_THRESHOLD_PX;
    dragging = undefined;
    document.body.classList.remove("dragging");
    if (wasClick) {
      const now = performance.now();
      // 双击（400ms 内两次有效点击）→ 唤起 App 主窗口；单击仍播放挥手。
      if (now - lastClickAt < 400) {
        bridge.openApp();
        lastClickAt = 0;
      } else {
        lastClickAt = now;
        animator.play("waving");
        scheduleSteadyRestore(3200);
      }
    } else {
      // 拖拽结束回稳态（会话进行中保持 waiting/running 等，不强制 idle）。
      animator.play(lastSteadyState);
    }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    // 右键弹菜单前终止任何在途拖拽会话（防御：菜单会吞掉后续 pointer 事件）。
    dragging = undefined;
    document.body.classList.remove("dragging");
    bridge.contextMenu();
  });

  window.addEventListener("beforeunload", () => {
    clearInterval(loop);
    clearInterval(lookLoop);
    if (steadyRestoreTimer) clearTimeout(steadyRestoreTimer);
    disposeState();
  });
}

void main();
