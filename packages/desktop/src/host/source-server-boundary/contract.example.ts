import type { ConnectSourceServerOptions } from "./contract.js";

/** 既有线路的重连输入；安装及 identity 变更仍需要调用方明确确认。 */
export const sourceServerConnectionExample = {
  membershipIntent: "retain",
  profile: {
    profileId: "fc30e5dd-190f-48f1-b43d-e5ca20291c0b",
    transport: "docker",
    target: { kind: "docker", container: "source-example" },
    createdAt: 1,
    lifecycleState: "active",
  },
  target: { kind: "docker", container: "source-example" },
  allowInstall: false,
  confirmIdentityChange: false,
} satisfies ConnectSourceServerOptions;
