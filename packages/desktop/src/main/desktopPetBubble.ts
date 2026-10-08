import { BrowserWindow, screen } from "electron";
import { DESKTOP_PET_BUBBLE_CHANNEL, type PetSessionBubblePayload } from "@zcode/shared";
import {
  PET_BUBBLE_WIDTH,
  computeBubbleBounds,
  computeBubbleHeight,
} from "./desktopPetBubbleBounds.js";

/**
 * 宠物会话气泡窗口（specs/desktop/desktop-pet.md 会话状态气泡）。
 * 形态复用 CUA 浮窗实测结论：`type:"panel"` 与 `focusable:false` 必须同时存在——
 * 少一个都会在点击时激活 App/抢走前台焦点。无符合条件的会话时 hide 复用不销毁。
 *
 * 初始化策略（修复首帧黑框）：窗口在创建时**预热**（隐藏加载页面），页面就绪
 * （did-finish-load）前的 payload 缓存不显示——避免"窗口已显示但页面未挂监听/未绘制"
 * 造成的黑框与首条数据丢失（首条丢失后要等 host 下一轮推送内容才出现）。
 */

interface PetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PetBubbleWindowController {
  update(payload: PetSessionBubblePayload, petBounds: PetBounds): void;
  reposition(petBounds: PetBounds): void;
  setCollapsed(petBounds: PetBounds, collapsed: boolean): void;
  hide(): void;
  isSender(webContentsId: number): boolean;
  /** 判断窗口是否归气泡管理：预热使气泡窗可能先于主窗口存在，必须从主窗候选排除。 */
  ownsWindow(win: BrowserWindow): boolean;
  destroy(): void;
}

export function createPetBubbleWindow(deps: {
  preloadPath: string;
  resolveRendererTarget: () => { devUrl?: string; rendererDir: string };
}): PetBubbleWindowController {
  let win: BrowserWindow | null = null;
  let lastPayload: PetSessionBubblePayload | null = null;
  let pageReady = false;
  let pendingBounds: PetBounds | null = null;
  let collapsed = false;

  const position = (petBounds: PetBounds, height: number) => {
    if (!win || win.isDestroyed()) return;
    const display = screen.getDisplayMatching(petBounds as Electron.Rectangle);
    win.setBounds(computeBubbleBounds(petBounds, height, display.workArea));
  };

  const apply = (payload: PetSessionBubblePayload, petBounds: PetBounds): void => {
    const window = ensureWindow();
    position(petBounds, computeBubbleHeight(payload, collapsed));
    if (!window.isVisible()) window.showInactive();
    window.webContents.send(DESKTOP_PET_BUBBLE_CHANNEL, payload);
  };

  // 预热：立即创建隐藏窗口并加载页面，首次会话出现时内容即时可显。
  const ensureWindow = (): BrowserWindow => {
    if (win && !win.isDestroyed()) return win;
    pageReady = false;
    win = new BrowserWindow({
      width: PET_BUBBLE_WIDTH,
      height: 96,
      type: "panel",
      frame: false,
      transparent: true,
      // 透明窗在首帧绘制前显示为黑块；显式透明底色避免该闪现。
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      // skipTaskbar 仅用于 Windows/Linux 任务栏；macOS 上 Electron 会把它映射成
      // App 级 Dock 图标隐藏——气泡首次创建后 Dock 图标消失的根因（panel 类型
      // 本来就不会出现在 macOS Dock，无需 skipTaskbar）。
      ...(process.platform === "darwin" ? {} : { skipTaskbar: true }),
      roundedCorners: false,
      show: false,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // 层级与 Space 行为只在创建时设置一次，且**不带 visibleOnFullScreen**：
    // E2E 实测带 visibleOnFullScreen 的 setVisibleOnAllWorkspaces 在首显（showInactive）
    // 时会引发 macOS 把 App 降为 accessory（Dock 图标消失）并扰动前台（用户实测
    // "唤起 ZCode"）；纯 visibleOnAllWorkspaces 的宠物窗从未触发。更新路径重复调用
    // 这些 API 亦无必要。
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true);
    const target = deps.resolveRendererTarget();
    if (target.devUrl) {
      void win.loadURL(`${target.devUrl}/pet-bubble.html`);
    } else {
      void win.loadFile(`${target.rendererDir}/pet-bubble.html`);
    }
    win.webContents.once("did-finish-load", () => {
      pageReady = true;
      // 就绪后补发缓存 payload（预热期间到达的首条数据），立即显示。
      if (lastPayload && lastPayload.rows.length > 0 && pendingBounds) {
        apply(lastPayload, pendingBounds);
      }
    });
    return win;
  };

  const controller: PetBubbleWindowController = {
    update(payload, petBounds) {
      pendingBounds = petBounds;
      if (payload.rows.length === 0) {
        lastPayload = null;
        this.hide();
        return;
      }
      lastPayload = payload;
      if (!pageReady) {
        // 页面未就绪：缓存 payload（等 did-finish-load 补发），避免黑框与首条丢失。
        ensureWindow();
        return;
      }
      apply(payload, petBounds);
    },
    reposition(petBounds) {
      // 空载荷（无会话）时窗口本就隐藏；此时 setBounds 会把窗口缩到纯 padding 高度，
      // macOS 透明窗口对隐藏窗口 setBounds 还可能触发短暂显影（用户实测"窄条复活"）。
      // 没有可见行就完全不动窗口。
      if (!win || win.isDestroyed() || !lastPayload || lastPayload.rows.length === 0) return;
      position(petBounds, computeBubbleHeight(lastPayload, collapsed));
    },
    setCollapsed(petBounds, value) {
      collapsed = value;
      if (!win || win.isDestroyed() || !lastPayload || lastPayload.rows.length === 0) return;
      position(petBounds, computeBubbleHeight(lastPayload, collapsed));
    },
    hide() {
      if (win && !win.isDestroyed() && win.isVisible()) win.hide();
    },
    isSender(webContentsId) {
      return win !== null && !win.isDestroyed() && win.webContents.id === webContentsId;
    },
    ownsWindow(target) {
      return win !== null && target === win && !win.isDestroyed();
    },
    destroy() {
      win?.destroy();
      win = null;
    },
  };
  // 预热（页面后台加载；窗口保持隐藏直到首条就绪数据）。
  ensureWindow();
  return controller;
}
