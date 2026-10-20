import { describe, expect, it, vi } from "vitest";
import {
  connectionProfileSchema,
  normalizeRemoteConnectionError,
  type AppSettings,
} from "@zcode/shared";
import {
  SourceServerConnectionManager,
  SourceServerDirectory,
  SourceServerIdentityChangePendingError,
  SourceServerInstallRequiredError,
  SourceServerUpgradeRequiredError,
  type SourceServerDirectoryOptions,
} from "./contract.js";
import { sourceServerConnectionExample } from "./contract.example.js";

describe("host-source-server public boundary", () => {
  const profileId = sourceServerConnectionExample.profile.profileId;

  it.each([
    [new SourceServerInstallRequiredError(profileId), "source-server-install-required"],
    [
      new SourceServerUpgradeRequiredError(profileId, "server", "1.0.0", "2.0.0"),
      "source-server-upgrade-required",
    ],
    [
      new SourceServerIdentityChangePendingError(profileId, "replacement-source"),
      "source-server-identity-change-pending",
    ],
  ] as const)("keeps explicit confirmation errors non-retryable: %s", (error, code) => {
    expect(error.profileId).toBe(profileId);
    expect(
      normalizeRemoteConnectionError(new Error("connect rejected", { cause: error })),
    ).toMatchObject({
      code,
      retryable: false,
    });
  });

  it("preserves controller upgrade and identity confirmation details for callers", () => {
    const upgrade = new SourceServerUpgradeRequiredError(profileId, "controller", "1.0.0", "2.0.0");
    expect(upgrade).toMatchObject({
      profileId,
      upgradeTarget: "controller",
      currentVersion: "1.0.0",
      minimumVersion: "2.0.0",
      reason: "compatibility",
    });
    expect(upgrade.message).toContain("Mikiko Desktop");
    expect(
      new SourceServerIdentityChangePendingError(profileId, "replacement-source")
        .pendingSourceServerId,
    ).toBe("replacement-source");
  });

  it("does not open a transport or invent an online owner when callers read absent state", () => {
    expect(connectionProfileSchema.parse(sourceServerConnectionExample.profile)).toEqual(
      sourceServerConnectionExample.profile,
    );
    const createAdapter = vi.fn(() => {
      throw new Error("Read-only boundary must not create a transport");
    });
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: async () => ({ identityChanged: false }) },
      createAdapter,
      now: () => 7,
    });
    try {
      expect(manager.getStateByProfile(profileId)).toEqual({
        profileId,
        state: "absent",
        updatedAt: 7,
      });
      expect(manager.listStates()).toEqual([]);
      expect(manager.getOnlineConnection("absent-source")).toBeUndefined();
      expect(() => manager.getFileTransfer("absent-source")).toThrow(
        "file transfer is unavailable",
      );
      expect(createAdapter).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it("publishes directory changes only after its existing persistence owner commits", async () => {
    let settings: AppSettings = {
      recentProjects: [],
      locale: "en-US",
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [sourceServerConnectionExample.profile],
    };
    let releaseWrite!: () => void;
    let announceWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      announceWrite = resolve;
    });
    const ports: SourceServerDirectoryOptions = {
      settingService: {
        get: async () => settings,
        update: async (patch) => {
          announceWrite();
          await writeGate;
          settings = { ...settings, ...patch };
        },
        updateDataBaseDir: async () => {},
      },
      credentialService: {
        load: async () => null,
        save: async () => {},
        delete: async () => {},
      },
    };
    const directory = new SourceServerDirectory(ports);
    const onChange = vi.fn();
    const subscription = directory.onDidChange(onChange);
    try {
      const first = await directory.snapshot();
      first.profiles.length = 0;
      expect((await directory.snapshot()).profiles).toHaveLength(1);
      expect(onChange).not.toHaveBeenCalled();
      const rename = directory.renameProfile(profileId, "  New route name  ");
      await writeStarted;
      expect(onChange).not.toHaveBeenCalled();
      expect(settings.connectionProfiles?.[0]?.displayName).toBeUndefined();
      releaseWrite();
      await rename;
      expect(onChange).toHaveBeenCalledTimes(1);
      expect((await directory.snapshot()).profiles[0]?.displayName).toBe("New route name");
    } finally {
      releaseWrite();
      subscription.dispose();
    }
  });
});
