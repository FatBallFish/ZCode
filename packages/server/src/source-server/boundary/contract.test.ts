import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createSourceServerTransportAdapter,
  SourceServerProbeEnvironmentError,
  type IRemoteBackend,
  type RemoteTarget,
  type StdioStream,
} from "./contract.js";
import { inspectSourceServer } from "./contract.example.js";

const target: RemoteTarget = { kind: "ssh", host: "contract.example", username: "fixture" };

function backendFixture(glibc = "2.28") {
  const output = [
    "__ZCODE_PROBE_PLATFORM__",
    "Linux",
    "__ZCODE_PROBE_ARCH__",
    "x86_64",
    "__ZCODE_PROBE_ROOT__",
    "/fixture/.mikiko/server",
    "__ZCODE_PROBE_KERNEL__",
    "Linux",
    "__ZCODE_PROBE_LIBC__",
    `glibc ${glibc}`,
    "__ZCODE_PROBE_INSTALLED__",
    "1",
    "__ZCODE_PROBE_RELEASE__",
    JSON.stringify({ archiveSha256: "A".repeat(64) }),
    "__ZCODE_PROBE_VERSION__",
    "1.1.3",
    "__ZCODE_PROBE_STATUS__",
    JSON.stringify({ state: "ready", port: 43123 }),
    "__ZCODE_PROBE_END__",
    "",
  ].join("\n");
  const backend: IRemoteBackend = {
    dispose() {},
    async detect() {
      return { platform: "linux", arch: "x64" };
    },
    async upload() {},
    async exists() {
      return false;
    },
    async readFile() {
      return "";
    },
    exec: vi.fn(
      async (): Promise<StdioStream> => ({
        stdin: new PassThrough(),
        stdout: Readable.from([output]),
        stderr: Readable.from([]),
        onClose(listener) {
          queueMicrotask(() => listener(0));
          return { dispose() {} };
        },
      }),
    ),
  };
  const createBackend = vi.fn(async () => backend);
  const adapter = createSourceServerTransportAdapter("ssh", { createBackend });
  return { adapter, backend, createBackend };
}

describe("Source Server transport public contract", () => {
  it("projects release identity and daemon facts in one read-only Mikiko probe", async () => {
    const { adapter, backend, createBackend } = backendFixture();
    try {
      await expect(inspectSourceServer(adapter, target)).resolves.toEqual({
        platform: "linux",
        arch: "x64",
        installed: true,
        installPath: "/fixture/.mikiko/server",
        installedVersion: "1.1.3",
        installedArchiveSha256: "a".repeat(64),
        daemonStatus: { state: "ready", port: 43123 },
      });
      expect(createBackend).toHaveBeenCalledTimes(1);
      expect(backend.exec).toHaveBeenCalledTimes(1);
      expect(vi.mocked(backend.exec).mock.calls[0]?.[0]).toContain(".mikiko/server");
    } finally {
      adapter.dispose?.();
    }
  });

  it("rejects unsupported glibc as an environment error before installation", async () => {
    const { adapter, backend } = backendFixture("2.17");
    try {
      const failure = await inspectSourceServer(adapter, target).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SourceServerProbeEnvironmentError);
      expect(failure).toMatchObject({ code: "remote-preflight-failed" });
      expect(backend.exec).toHaveBeenCalledTimes(1);
    } finally {
      adapter.dispose?.();
    }
  });

  it("rejects an already canceled probe before acquiring any backend", async () => {
    const { adapter, backend, createBackend } = backendFixture();
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(inspectSourceServer(adapter, target, controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(createBackend).not.toHaveBeenCalled();
      expect(backend.exec).not.toHaveBeenCalled();
    } finally {
      adapter.dispose?.();
    }
  });
});
