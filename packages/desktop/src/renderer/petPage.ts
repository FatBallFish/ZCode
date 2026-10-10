import type { ActivePetView } from "@zcode/shared";
import { PET_CLICK_THRESHOLD_PX, createPetAnimator } from "@zcode/shared";

/**
 * 宠物窗口页面（vanilla，无 React）：canvas 逐帧绘制 petpack:// 图集；
 * 拖拽为锚点式——pointerdown 上报 main 接管移动，pointerup 取回累计位移判定点击；
 * 方向动画由 main 推送。点击播放 waving；右键弹 main 菜单。
 * 交互细节：移动与方向判定都不在页面侧计算（screenX/Y 在混合 DPI 多屏下与
 * main 坐标系不一致，曾导致跨屏错位与松手后触碰瞬闪）。
 */

interface DesktopPetBridge {
  getActive(): Promise<{
    view: ActivePetView;
    state: "idle" | "running" | "waiting" | "failed" | "review";
  } | null>;
  dragStart(): void;
  dragEnd(): Promise<{ movedPx: number }>;
  contextMenu(): void;
  openApp(): void;
  onState(
    callback: (event: {
      state: "idle" | "running" | "waiting" | "failed" | "review" | "waving";
    }) => void,
  ): () => void;
  onDragDirection(callback: (event: { direction: string }) => void): () => void;
}

declare global {
  interface Window {
    desktopPet?: DesktopPetBridge;
  }
}

const FRAME_ANIMATION_INTERVAL_MS = 16;
const LOOK_INTERVAL_MIN_MS = 20_000;
const LOOK_INTERVAL_JITTER_MS = 20_000;

const bridge = window.desktopPet;
const canvas = document.getElementById("stage") as HTMLCanvasElement | null;

/** 拖拽会话只保留 pointer 身份：移动真值与方向判定都在 main。 */
interface DragSession {
  pointerId: number;
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

  // main 迟滞判定后推送的跑动方向（左右/竖直 running）。
  const disposeDragDirection = bridge.onDragDirection((event) => {
    animator.play(event.direction);
  });

  canvas.addEventListener("pointerdown", (event) => {
    // 只有主键（左键）可以开始拖拽：右键按下会弹菜单，菜单吞掉 pointerup，
    // 拖拽会话悬空表现为"宠物一直跟着鼠标走，直到再点一次左键"。
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    dragging = { pointerId: event.pointerId };
    document.body.classList.add("dragging");
    bridge.dragStart();
  });
  const endDrag = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    dragging = undefined;
    document.body.classList.remove("dragging");
    void (async () => {
      // main 侧实际应用位移的累计是点击判定唯一真值：页面侧 screenX 在混合 DPI
      // 多屏下可能产生假增量（点击被误判成拖拽）；IPC 失败保守按拖拽处理。
      let movedPx = Number.POSITIVE_INFINITY;
      try {
        movedPx = (await bridge.dragEnd()).movedPx;
      } catch {
        // 保留默认 Infinity：不触发点击动作。
      }
      if (movedPx <= PET_CLICK_THRESHOLD_PX) {
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
    })();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  // 防御：pointerup 被吞（系统菜单/窗口失活）时 capture 丢失也能终止拖拽。
  canvas.addEventListener("lostpointercapture", endDrag);
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    // 右键弹菜单前终止任何在途拖拽会话（防御：菜单会吞掉后续 pointer 事件）。
    dragging = undefined;
    document.body.classList.remove("dragging");
    void bridge.dragEnd().catch(() => undefined);
    bridge.contextMenu();
  });

  window.addEventListener("beforeunload", () => {
    clearInterval(loop);
    clearInterval(lookLoop);
    if (steadyRestoreTimer) clearTimeout(steadyRestoreTimer);
    disposeState();
    disposeDragDirection();
  });
}

void main();
