import { describe, expect, it, vi } from "vitest";
import { utilityProcess } from "electron";
import { spawnVoiceEngineWorker } from "../src/main/voice/desktopVoiceIpc.js";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

describe("voice worker process boundary", () => {
  it("launches the supplied worker through Electron with its public Mikiko process name", () => {
    const child = { pid: 123 };
    vi.mocked(utilityProcess.fork).mockReturnValue(child as never);
    expect(spawnVoiceEngineWorker("/isolated/voice-worker.js")).toBe(child);
    expect(utilityProcess.fork).toHaveBeenCalledWith("/isolated/voice-worker.js", [], {
      serviceName: "mikiko-voice-engine",
      execArgv: ["--no-warnings"],
    });
  });
});
