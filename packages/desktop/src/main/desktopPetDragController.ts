import { screen, type BrowserWindow } from "electron";
import { createPetDragDirectionTracker } from "@zcode/shared";

/**
 * 宠物拖拽控制器（specs/desktop/desktop-pet.md 拖拽一节；2026-10-11 锚点式重构）。
 *
 * 旧方案（逐 pointer 增量 + renderer screenX/Y）的两个致命假设在混合 DPI 多屏
 * 不成立：① screenX/Y 与 setBounds 同坐标系——实际 Chromium 按窗口/光标所在
 * 显示器缩放换算全局坐标，跨屏瞬间换算空间突变，增量被缩放/偏移 → 宠物跟不上
 * 鼠标、累计错位（用户实测「鼠标挪到另一个屏幕宠物没过去」）；② pointerdown 与
 * 随后 pointermove 同空间——不同空间会产生单次巨量假增量，松手后再触碰宠物时
 * 瞬闪约等于上次松手时的偏差距离。本控制器改由 main 用与 setBounds 同坐标系的
 * screen.getCursorScreenPoint() 做绝对重算（无累计误差，天然免疫 clamp 漂移），
 * 60Hz 定时循环也顺带解决高回报率鼠标（≥500Hz）下逐事件 IPC 洪泛的卡顿/刷新感。
 */

/** 拖拽 tick 频率：≈60Hz，与动画帧率对齐；也是移动 IPC 的天然节流上限。 */
const DRAG_TICK_MS = 16;

export interface PetDragControllerDeps {
  /** 宠物窗引用（生命周期唯一所有者是 manager，控制器只读；窗口销毁即自动停）。 */
  getPetWindow: () => BrowserWindow | null;
  windowSize: { width: number; height: number };
  clampIntoWorkArea: (
    position: { x: number; y: number },
    size: { width: number; height: number },
  ) => { x: number; y: number };
  /** 位置持久化（manager 侧 debounce 落盘）。 */
  persistPositionSoon: () => void;
  /** 气泡窗口跟随（空载荷时内部自带 no-op 守卫）。 */
  repositionBubble: (bounds: Electron.Rectangle) => void;
  /** 方向动画推送（迟滞判定后仅在切换时调用）。 */
  sendDragDirection: (direction: string) => void;
}

export interface PetDragController {
  /** 记录锚点（光标 + 窗口当前位置）并启动 tick 循环；重复调用重新锚定。 */
  start(): void;
  /** 停止循环；返回实际应用位移累计（点击判定的唯一真值）。 */
  end(): { movedPx: number };
  /** 无条件停止（窗口销毁/禁用宠物路径），不返回位移。 */
  stop(): void;
}

interface PetDragSession {
  timer: ReturnType<typeof setInterval>;
  anchorCursor: { x: number; y: number };
  anchorOrigin: { x: number; y: number };
  tracker: ReturnType<typeof createPetDragDirectionTracker>;
  lastApplied: { x: number; y: number };
  /** 气泡跟随降频计数：气泡同为透明窗，逐 tick setBounds 会叠加合成开销。 */
  bubbleTick: number;
}

export function createPetDragController(deps: PetDragControllerDeps): PetDragController {
  let dragSession: PetDragSession | null = null;

  const stopDragLoop = () => {
    if (!dragSession) return;
    clearInterval(dragSession.timer);
    dragSession = null;
  };

  const dragTick = () => {
    const session = dragSession;
    const petWindow = deps.getPetWindow();
    if (!petWindow || petWindow.isDestroyed()) {
      stopDragLoop();
      return;
    }
    if (!session) return;
    const cursor = screen.getCursorScreenPoint();
    const next = deps.clampIntoWorkArea(
      {
        x: session.anchorOrigin.x + (cursor.x - session.anchorCursor.x),
        y: session.anchorOrigin.y + (cursor.y - session.anchorCursor.y),
      },
      deps.windowSize,
    );
    // setBounds 携带常量尺寸（而非 setPosition）：Windows 非 100% 缩放下透明窗
    // setPosition 存在 DIP↔物理取整逐次漂移（旧版「拖动即放大」根因），混合 DPI
    // 跨屏 WM_DPICHANGED 建议矩形也会上下/左右拉伸——每帧钉尺寸让漂移活不过
    // 一帧；resize 监听钉住仅作最终防线，不参与高频路径。
    petWindow.setBounds({
      x: next.x,
      y: next.y,
      width: deps.windowSize.width,
      height: deps.windowSize.height,
    });
    // 方向判定用 clamp 后的实际应用位移：被屏幕边缘夹住的抖动不应切换跑动方向。
    // Electron 的位置数组类型不保证索引存在；bounds 提供同坐标系的必填 x/y。
    const { x: appliedX, y: appliedY } = petWindow.getBounds();
    const direction = session.tracker.push(
      appliedX - session.lastApplied.x,
      appliedY - session.lastApplied.y,
      Date.now(),
    );
    session.lastApplied = { x: appliedX, y: appliedY };
    if (direction) {
      deps.sendDragDirection(direction);
    }
    // 程序化 setBounds 不保证触发 moved 事件；拖拽路径自行驱动持久化与气泡跟随。
    deps.persistPositionSoon();
    // 气泡以 ~20Hz 跟随（每 3 tick）：60Hz 下人眼对副窗跟随延迟不敏感，
    // 但透明窗逐帧 setBounds 在高分屏上会叠加明显的合成负载（拖动卡顿反馈主因之一）。
    session.bubbleTick = (session.bubbleTick + 1) % 3;
    if (session.bubbleTick === 0) {
      deps.repositionBubble(petWindow.getBounds());
    }
  };

  return {
    start() {
      const petWindow = deps.getPetWindow();
      if (!petWindow || petWindow.isDestroyed()) return;
      stopDragLoop();
      const anchorCursor = screen.getCursorScreenPoint();
      const { x: originX, y: originY } = petWindow.getBounds();
      dragSession = {
        timer: setInterval(dragTick, DRAG_TICK_MS),
        anchorCursor,
        anchorOrigin: { x: originX, y: originY },
        tracker: createPetDragDirectionTracker(),
        lastApplied: { x: originX, y: originY },
        bubbleTick: 0,
      };
    },
    end() {
      const movedPx = dragSession?.tracker.movedPx ?? 0;
      stopDragLoop();
      deps.persistPositionSoon();
      // 跟随降频（每 3 tick）可能在松手瞬间欠一拍，结束时对齐一次最终位置。
      const petWindow = deps.getPetWindow();
      if (petWindow && !petWindow.isDestroyed()) {
        deps.repositionBubble(petWindow.getBounds());
      }
      return { movedPx };
    },
    stop() {
      stopDragLoop();
    },
  };
}
