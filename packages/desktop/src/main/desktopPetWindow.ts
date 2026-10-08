import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, Menu, app, ipcMain, protocol, screen } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import {
  DESKTOP_PET_STATE_CHANNEL,
  PlatformChannels,
  normalizePetManifest,
  petTaskKey,
  readWebpSize,
  resolvePetAnimationState,
  type ActivePetView,
  type PetSessionBubblePayload,
  type PetSessionSummary,
} from "@zcode/shared";
import type { PetBubbleWindowController } from "./desktopPetBubble.js";
import type { PetMarketService } from "./desktopPetMarketService.js";

/**
 * 桌面宠物窗口与 petpack:// 协议（specs/desktop/desktop-pet.md）。
 *
 * 窗口生命周期唯一所有者是 main：设置（desktopPetEnabled/desktopPetId）变化经
 * applySettings 即时增删窗口；宠物页面只经专用 preload（window.desktopPet）通信，
 * 状态推送（agent 运行态、启用问候）走 DESKTOP_PET_STATE_CHANNEL。
 * 协议只放行已安装宠物目录内的 webp/json，参照 localMediaPreviewProtocol 的
 * registerFileProtocol 先例（Electron 41 下比 protocol.handle 稳）。
 */

export const PET_PACK_SCHEME = "petpack";

/** app ready 前注册 privileged scheme（standard 使 query 参数按标准 URL 解析）。 */
export function registerPetPackScheme(electronProtocol: typeof protocol): void {
  electronProtocol.registerSchemesAsPrivileged([
    { scheme: PET_PACK_SCHEME, privileges: { standard: true, secure: true, stream: true } },
  ]);
}

const NET_ERR_INVALID_URL = -300;

/** 安装 petpack://local/asset?path=<abs> → 本地文件；路径不在宠物根目录内即拒绝。 */
export function installPetPackProtocol(
  electronProtocol: typeof protocol,
  options: { isPathAllowed: (path: string) => boolean },
): void {
  electronProtocol.registerFileProtocol(PET_PACK_SCHEME, (request, callback) => {
    try {
      const url = new URL(request.url);
      const path = url.searchParams.get("path") ?? "";
      if (url.hostname !== "local" || url.pathname !== "/asset" || !options.isPathAllowed(path)) {
        callback({ error: NET_ERR_INVALID_URL });
        return;
      }
      callback({ path });
    } catch {
      callback({ error: NET_ERR_INVALID_URL });
    }
  });
}

/** 帧绘制缩放：192x208 → 约 115x125 DIP，宠物在桌面上足够小巧。 */
const PET_WINDOW_SCALE = 0.6;

export interface DesktopPetManagerDeps {
  /** 宠物窗口专用 preload（out/preload/desktopPet.cjs）。 */
  petPreloadPath: string;
  petRootDir: () => string;
  market: PetMarketService;
  logger: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
  };
  /** 位置持久化（调用方负责 debounce 落盘 settings.desktopPetPosition）。 */
  savePosition: (position: { x: number; y: number }) => void;
  /** 菜单「隐藏宠物」：调用方写 settings.desktopPetEnabled=false。 */
  hidePet: () => void;
  /** 菜单「宠物设置」：打开设置页宠物分区。 */
  openPetSettings: () => void;
  menuLabels: { manage: string; hide: string };
  /** 会话气泡窗口（由调用方创建；manager 只负责随宠物显隐/跟随/推送内容）。 */
  bubble: PetBubbleWindowController;
  /** 气泡行点击：聚焦主窗口并跳转到对应会话（index.ts 复用系统通知点击链路）。 */
  onOpenTask: (summary: PetSessionSummary) => void;
  /** 双击宠物：唤起 App 主窗口（不指定会话）。 */
  onOpenApp: () => void;
  /** 当前应用主题（nativeTheme 解析）；气泡跟随切换。 */
  getTheme: () => "dark" | "light";
}

interface PetSettingsSnapshot {
  enabled?: boolean;
  petId?: string;
  position?: { x: number; y: number };
}

function clampIntoWorkArea(
  position: { x: number; y: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  const display =
    screen.getDisplayNearestPoint({ x: Math.round(position.x), y: Math.round(position.y) }) ??
    screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const x = Math.min(
    Math.max(Math.round(position.x), workArea.x),
    workArea.x + Math.max(workArea.width - size.width, 0),
  );
  const y = Math.min(
    Math.max(Math.round(position.y), workArea.y),
    workArea.y + Math.max(workArea.height - size.height, 0),
  );
  return { x, y };
}

export interface DesktopPetManager {
  /** 设置快照驱动：enabled/petId 变化时创建/销毁/重建窗口。 */
  applySettings(settings: PetSettingsSnapshot): void;
  /** agent 运行态联动（只读订阅；无会话摘要时的兜底输入）。 */
  setAgentRunning(running: boolean): void;
  /** 会话状态摘要（多 host 合并后）：驱动气泡显隐/内容与宠物状态优先级映射。 */
  setSessionSummaries(payload: PetSessionBubblePayload): void;
  /** 判断窗口是否归宠物管理：辅助窗不能被主窗口协调器当主窗复用。 */
  ownsWindow(win: BrowserWindow): boolean;
  destroy(): void;
}

export function createDesktopPetManager(deps: DesktopPetManagerDeps): DesktopPetManager {
  let petWindow: BrowserWindow | null = null;
  let activePetId: string | undefined;
  let positionSaveTimer: ReturnType<typeof setTimeout> | undefined;

  const windowSize = {
    width: Math.round(192 * PET_WINDOW_SCALE),
    height: Math.round(208 * PET_WINDOW_SCALE),
  };

  const sendState = (event: { state: DesktopPetManagerState }) => {
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send(DESKTOP_PET_STATE_CHANNEL, event);
    }
  };
  type DesktopPetManagerState = "idle" | "running" | "waiting" | "failed" | "review" | "waving";

  // 会话摘要驱动（specs/desktop/desktop-pet.md 会话状态气泡）：摘要优先、运行计数兜底。
  let sessionSummaries: PetSessionBubblePayload = { rows: [], overflowCount: 0 };
  // 用户关闭的终态行（taskKey）：不落盘，本次运行内不再展示；该会话重新进入
  // running/waiting 时自动移出集合（新活动复活）。
  const dismissedTerminalKeys = new Set<string>();
  const isTerminal = (row: PetSessionSummary) =>
    row.liveStatus === "completed" || row.liveStatus === "error";
  const filterSummaries = (payload: PetSessionBubblePayload): PetSessionBubblePayload => {
    const rows = payload.rows.filter((row) => {
      if (!isTerminal(row)) {
        dismissedTerminalKeys.delete(petTaskKey(row));
        return true;
      }
      return !dismissedTerminalKeys.has(petTaskKey(row));
    });
    return {
      ...payload,
      rows,
      overflowCount: Math.max(0, payload.overflowCount - (payload.rows.length - rows.length)),
    };
  };
  let agentRunningTotal = 0;
  // 当前派生稳态：宠物页 onState 是异步注册的，可能错过 main 的首次推送；
  // PetGetActive 携带该值让页面初始化即恢复正确动作（waving 瞬态不含在内）。
  let lastDerivedState: import("@zcode/shared").DesktopPetSteadyState = "idle";
  const petBounds = () => (petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null);
  const refreshBubble = () => {
    const bounds = petBounds();
    if (!bounds) {
      deps.bubble.hide();
      return;
    }
    deps.bubble.update({ ...sessionSummaries, theme: deps.getTheme() }, bounds);
  };
  const refreshDerivedState = () => {
    lastDerivedState = resolvePetAnimationState(sessionSummaries.rows, agentRunningTotal);
    sendState({ state: lastDerivedState });
    refreshBubble();
  };

  const persistPositionSoon = () => {
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(() => {
      positionSaveTimer = undefined;
      if (!petWindow || petWindow.isDestroyed()) return;
      const [x, y] = petWindow.getPosition();
      deps.savePosition(clampIntoWorkArea({ x, y }, windowSize));
    }, 800);
  };

  const buildContextMenu = (): Menu => {
    const items: MenuItemConstructorOptions[] = [
      { label: deps.menuLabels.manage, click: () => deps.openPetSettings() },
      { type: "separator" },
      { label: deps.menuLabels.hide, click: () => deps.hidePet() },
    ];
    return Menu.buildFromTemplate(items);
  };

  const resolveActivePet = (): ActivePetView | null => {
    if (!activePetId) return null;
    return resolvePetPreview(activePetId);
  };

  const resolvePetPreview = (petId: string): ActivePetView | null => {
    const local = deps.market.loadLocalPet(petId);
    if (!local) return null;
    const sheetPath = join(local.petDir, "spritesheet.webp");
    let sheetBytes: Buffer;
    try {
      sheetBytes = readFileSync(sheetPath);
    } catch {
      return null;
    }
    // nativeImage 不解码 WebP（仅 PNG/JPEG），尺寸走自研容器头解析。
    const size = readWebpSize(new Uint8Array(sheetBytes));
    if (!size) return null;
    const normalized = normalizePetManifest({
      manifest: local.manifest,
      fallbackId: petId,
      sheetWidth: size.width,
      sheetHeight: size.height,
    });
    if (!normalized.ok) {
      deps.logger.warn("[desktop-pet] pet manifest invalid", { petId, error: normalized.error });
      return null;
    }
    return {
      pet: normalized.pet,
      spritesheetUrl: `${PET_PACK_SCHEME}://local/asset?path=${encodeURIComponent(sheetPath)}`,
      opaqueFallback: false,
    };
  };

  const createWindow = (settings: PetSettingsSnapshot) => {
    const view = resolveActivePet();
    if (!view) {
      deps.logger.warn("[desktop-pet] enabled but pet unavailable", { petId: settings.petId });
      return;
    }
    petWindow = new BrowserWindow({
      ...windowSize,
      // type:panel + focusable:false 必须同时存在（CUA 浮窗实测结论）：只设 focusable:false
      // 时点击仍会激活 App、焦点落到主窗——台前调度（Stage Manager）下表现为"一点击/
      // 拖动宠物整个 App 被唤到前台"。panel 类型让窗口成为非激活面板，点击零焦点事件。
      type: "panel",
      frame: false,
      transparent: true,
      resizable: false,
      // 同气泡窗口：skipTaskbar 在 macOS 被 Electron 映射成 Dock 图标隐藏，仅非 macOS 设置。
      ...(process.platform === "darwin" ? {} : { skipTaskbar: true }),
      hasShadow: false,
      focusable: false,
      roundedCorners: false,
      // 桌面宠物是全桌面陪伴物：不跟随 Space/虚拟桌面切换会表现为「启用后看不到宠物」
      // （E2E 实测多显示器 + 多 Space 下窗口在别的 Space 存活，用户当前 Space 不可见）。
      visibleOnAllWorkspaces: true,
      show: false,
      webPreferences: {
        preload: deps.petPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    petWindow.setAlwaysOnTop(true, "screen-saver");
    const position = clampIntoWorkArea(
      settings.position ?? defaultBottomRightPosition(windowSize),
      windowSize,
    );
    petWindow.setPosition(position.x, position.y, false);

    if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
      void petWindow.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/pet.html`);
    } else {
      void petWindow.loadFile(join(import.meta.dirname, "../renderer/pet.html"));
    }
    petWindow.once("ready-to-show", () => {
      if (!petWindow || petWindow.isDestroyed()) return;
      petWindow.show();
      // 不在此处做 dock.show 防御：skipTaskbar 已在 macOS 移除（Dock 图标不再会被隐去），
      // 且 dock.show 可能带来激活副作用——启动/首次会话不应有任何唤起动作。
      sendState({ state: "waving" });
      refreshBubble();
    });
    petWindow.on("moved", () => {
      persistPositionSoon();
      const bounds = petBounds();
      if (bounds) deps.bubble.reposition(bounds);
    });
    petWindow.on("closed", () => {
      petWindow = null;
      deps.bubble.hide();
    });
    petWindow.webContents.on("render-process-gone", () => {
      deps.logger.warn("[desktop-pet] renderer gone", { petId: activePetId });
    });
  };

  const destroyWindow = () => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
    petWindow = null;
    deps.bubble.hide();
  };

  // —— 宠物窗口专用 IPC（校验 sender 归属宠物窗口，其它窗口一律拒绝）——
  const isPetWindowSender = (sender: Electron.WebContents) =>
    petWindow !== null && !petWindow.isDestroyed() && petWindow.webContents === sender;

  ipcMain.handle(PlatformChannels.PetGetActive, (event) => {
    if (!isPetWindowSender(event.sender)) return null;
    const view = resolveActivePet();
    if (!view) return null;
    return { view, state: lastDerivedState };
  });

  ipcMain.on(PlatformChannels.PetDragMove, (event, payload: { dx: number; dy: number }) => {
    if (!isPetWindowSender(event.sender) || !petWindow || petWindow.isDestroyed()) return;
    if (!Number.isFinite(payload?.dx) || !Number.isFinite(payload?.dy)) return;
    const [x, y] = petWindow.getPosition();
    const next = clampIntoWorkArea(
      { x: x + Math.round(payload.dx), y: y + Math.round(payload.dy) },
      windowSize,
    );
    petWindow.setPosition(next.x, next.y, false);
    // 程序化 setPosition 在部分平台不触发 moved 事件；拖拽路径自行驱动持久化。
    persistPositionSoon();
    // 气泡跟随宠物拖拽（bounds 用夹取后的真实窗口位置）。
    const bounds = petWindow.getBounds();
    deps.bubble.reposition(bounds);
  });

  ipcMain.on(PlatformChannels.PetContextMenu, (event) => {
    if (!isPetWindowSender(event.sender)) return;
    buildContextMenu().popup({ window: petWindow ?? undefined });
  });

  // 设置页已安装卡片：返回本地图集的规范化清单 + petpack:// 地址（主窗口同 session 可加载）。
  ipcMain.handle(PlatformChannels.PetGetInstalledPreview, (_event, payload: { petId: string }) => {
    if (typeof payload?.petId !== "string") return null;
    return resolvePetPreview(payload.petId);
  });

  // 气泡行点击：只接受气泡窗口的请求；payload 至少要有 taskId 才值得跳转。
  ipcMain.on(
    PlatformChannels.PetBubbleOpenTask,
    (event, payload: PetSessionSummary | undefined) => {
      if (!deps.bubble.isSender(event.sender.id)) return;
      if (!payload || typeof payload.taskId !== "string") return;
      deps.onOpenTask(payload);
    },
  );

  // 双击宠物唤起 App 主窗口（不指定会话）。
  ipcMain.on(PlatformChannels.PetOpenApp, (event) => {
    if (!isPetWindowSender(event.sender)) return;
    deps.onOpenApp();
  });

  // 气泡行关闭/清空：只接受气泡窗口请求；清空仅作用于终态行（running/waiting 不受影响）。
  ipcMain.on(
    PlatformChannels.PetBubbleDismissTask,
    (event, payload: PetSessionSummary | undefined) => {
      if (!deps.bubble.isSender(event.sender.id)) return;
      if (!payload || typeof payload.taskId !== "string" || !isTerminal(payload)) return;
      dismissedTerminalKeys.add(petTaskKey(payload));
      const bounds = petBounds();
      if (bounds && sessionSummaries.rows.length > 0) {
        sessionSummaries = filterSummaries(sessionSummaries);
        deps.bubble.update({ ...sessionSummaries, theme: deps.getTheme() }, bounds);
      } else {
        deps.bubble.hide();
      }
    },
  );
  ipcMain.on(PlatformChannels.PetBubbleClearTerminal, (event) => {
    if (!deps.bubble.isSender(event.sender.id)) return;
    for (const row of sessionSummaries.rows) {
      if (isTerminal(row)) dismissedTerminalKeys.add(petTaskKey(row));
    }
    sessionSummaries = filterSummaries(sessionSummaries);
    const bounds = petBounds();
    if (bounds && sessionSummaries.rows.length > 0) {
      deps.bubble.update({ ...sessionSummaries, theme: deps.getTheme() }, bounds);
    } else {
      deps.bubble.hide();
    }
  });
  // 折叠/展开：页面切换列表显隐，窗口高度联动收缩。
  ipcMain.on(PlatformChannels.PetBubbleSetCollapsed, (event, value: unknown) => {
    if (!deps.bubble.isSender(event.sender.id) || typeof value !== "boolean") return;
    const bounds = petBounds();
    if (bounds) deps.bubble.setCollapsed(bounds, value);
  });

  return {
    applySettings(settings) {
      // 未显式选宠时回退第一只已安装（内置预置后必然有值），保证开关可用。
      let petId = settings.petId;
      if (settings.enabled === true && !petId) {
        petId = deps.market.listInstalled()[0]?.id;
      }
      const desiredActive = settings.enabled === true && Boolean(petId);
      const petChanged = petId !== activePetId;
      if (!desiredActive) {
        if (petWindow) destroyWindow();
        activePetId = petId;
        return;
      }
      if (petWindow && !petWindow.isDestroyed() && !petChanged) return;
      if (petWindow) destroyWindow();
      activePetId = petId;
      createWindow({ ...settings, petId });
    },
    setAgentRunning(running) {
      const total = running ? Math.max(agentRunningTotal, 1) : 0;
      if (total === agentRunningTotal) return;
      agentRunningTotal = total;
      refreshDerivedState();
    },
    setSessionSummaries(payload) {
      sessionSummaries = filterSummaries(payload);
      refreshDerivedState();
    },
    ownsWindow(target) {
      // 修复依据：启动序中宠物/气泡（预热）窗口先于主窗口创建（bootstrap applySettings 在
      // ensurePrimaryWindow 之前），主窗口协调器会把「已存在的窗口」误当主窗复用，
      // 导致启用宠物后启动 App 不再出现主界面。所有辅助窗都必须从主窗候选中排除。
      return (
        (petWindow !== null && target === petWindow && !petWindow.isDestroyed()) ||
        deps.bubble.ownsWindow(target)
      );
    },
    destroy() {
      if (positionSaveTimer) clearTimeout(positionSaveTimer);
      positionSaveTimer = undefined;
      deps.bubble.destroy();
      destroyWindow();
    },
  };
}

function defaultBottomRightPosition(size: { width: number; height: number }): {
  x: number;
  y: number;
} {
  const workArea = screen.getPrimaryDisplay().workArea;
  const margin = 24;
  return {
    x: workArea.x + workArea.width - size.width - margin,
    y: workArea.y + workArea.height - size.height - margin,
  };
}
