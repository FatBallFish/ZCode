import { dirname, join } from "node:path";
/**
 * 语音 IPC 注册（renderer ↔ main；specs/desktop/voice-input.md §5.1）。
 * 进程内实现细节不外泄：VoiceService 是唯一所有者，本层只做转发与广播。
 */
import {
  BrowserWindow,
  ipcMain,
  app,
  shell,
  systemPreferences,
  utilityProcess,
  type WebContents,
} from "electron";
import { PlatformChannels } from "@zcode/shared";
import type {
  DesktopVoiceService,
  VoiceEngineChildProcess,
  VoiceEventSink,
} from "./desktopVoiceService.js";
import { createVoiceMicPermission } from "./voiceMicPermission.js";

export function spawnVoiceEngineWorker(modulePath: string): VoiceEngineChildProcess {
  return utilityProcess.fork(modulePath, [], {
    serviceName: "mikiko-voice-engine",
    execArgv: ["--no-warnings"],
  });
}

function toEventSink(contents: WebContents): VoiceEventSink {
  return {
    send: (channel, payload) => {
      if (!contents.isDestroyed()) contents.send(channel, payload);
    },
    isDestroyed: () => contents.isDestroyed(),
  };
}

export function registerVoiceIpc(options: { service: DesktopVoiceService }): void {
  const { service } = options;

  ipcMain.handle(PlatformChannels.VoiceGetState, () => service.getState());

  ipcMain.handle(PlatformChannels.VoiceDownloadModel, (_event, payload?: { modelId?: string }) => {
    if (typeof payload?.modelId !== "string") return { ok: false, error: "invalid request" };
    return service.downloadModel(payload.modelId);
  });

  ipcMain.handle(PlatformChannels.VoiceDeleteModel, (_event, payload?: { modelId?: string }) => {
    if (typeof payload?.modelId !== "string") return { ok: false, error: "invalid request" };
    return service.deleteModel(payload.modelId);
  });

  ipcMain.handle(PlatformChannels.VoiceStartSession, (event, payload?: { modelId?: string }) => {
    if (
      payload !== undefined &&
      (typeof payload !== "object" ||
        (payload.modelId !== undefined && typeof payload.modelId !== "string"))
    ) {
      return { ok: false as const, error: "model-not-found" as const };
    }
    return service.startSession(toEventSink(event.sender), { modelId: payload?.modelId });
  });

  // 音频帧走 ipcMain.on（高频、单向；Int16Array 经 structured clone 传递）。
  ipcMain.on(
    PlatformChannels.VoiceFeedAudio,
    (event, payload?: { sessionId?: string; samples?: Int16Array }) => {
      if (
        typeof payload?.sessionId !== "string" ||
        !(payload.samples instanceof Int16Array) ||
        payload.samples.length === 0
      ) {
        return;
      }
      service.feedAudio(payload.sessionId, payload.samples);
    },
  );

  ipcMain.handle(
    PlatformChannels.VoiceFinishSession,
    (_event, payload?: { sessionId?: string }) => {
      if (typeof payload?.sessionId !== "string") {
        return { ok: false as const, error: "invalid request" };
      }
      return service.finishSession(payload.sessionId);
    },
  );

  ipcMain.handle(
    PlatformChannels.VoiceCancelSession,
    (_event, payload?: { sessionId?: string }) => {
      if (typeof payload?.sessionId !== "string") return;
      service.cancelSession(payload.sessionId);
    },
  );

  ipcMain.handle(PlatformChannels.VoiceUnloadEngine, () => service.unloadEngine());

  // 麦克风权限（§3.5）：main 侧 systemPreferences 是唯一事实源，renderer 只读+发命令。
  // 注意 Electron 41 的申请 API 是 askForMediaAccess（旧名 askForMediaAccessPermission 不存在）。
  const micPermission = createVoiceMicPermission({
    platform: process.platform,
    getMediaAccessStatus: (mediaType) => systemPreferences.getMediaAccessStatus(mediaType),
    askForMediaAccess: (mediaType) => systemPreferences.askForMediaAccess(mediaType),
    openExternal: (url) => shell.openExternal(url),
    // dev 构建注入 TCC 重置：dev bundle 每次重编译 ad-hoc 签名 cdhash 变化，
    // 历史 deny 记录对新副本失配且系统设置无删除入口，「去开启」需要能自愈回弹框。
    // 生产打包版保持原语义（用户明确拒绝过的不被重置）。
    ...(app.isPackaged
      ? {}
      : {
          resetMicApproval: async () => {
            const { execFile } = await import("node:child_process");
            const { promisify } = await import("node:util");
            // Electron 41 没有 app.getBundleId；从当前可执行 App 的签名身份读取，
            // 不硬编码品牌 ID，避免重置错误副本的麦克风授权。
            const infoPlist = join(dirname(process.execPath), "..", "Info.plist");
            const { stdout } = await promisify(execFile)("/usr/libexec/PlistBuddy", [
              "-c",
              "Print :CFBundleIdentifier",
              infoPlist,
            ]);
            const bundleId = stdout.trim();
            if (bundleId) await promisify(execFile)("tccutil", ["reset", "Microphone", bundleId]);
          },
        }),
  });
  ipcMain.handle(PlatformChannels.VoiceGetMicPermissionStatus, () => micPermission.getStatus());
  ipcMain.handle(PlatformChannels.VoiceEnsureMicPermission, () => micPermission.ensure());
  ipcMain.handle(PlatformChannels.VoiceOpenMicPermissionSettings, () =>
    micPermission.openSystemSettings(),
  );

  service.onSnapshot((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(PlatformChannels.VoiceStateChanged, snapshot);
      }
    }
  });

  service.onSessionEvent((sender, sessionId, event) => {
    sender.send(PlatformChannels.VoiceSessionEvent, { sessionId, event });
  });
}
