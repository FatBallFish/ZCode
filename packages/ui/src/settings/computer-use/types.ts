/** Presentation snapshot; runtime permission ownership stays in the existing service/hook. */
export type MikikoComputerUsePermissionSnapshot =
  | { available: false; reason: string }
  | {
      available?: true;
      accessibility: "granted" | "stale" | "denied" | "unknown";
      screenRecording: "granted" | "stale" | "denied" | "unknown";
      backend?: string;
      appPath?: string;
    };
