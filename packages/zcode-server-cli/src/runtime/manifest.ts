import { platform, arch } from "node:process";
import { SERVER_RUNTIME_NODE_VERSION } from "../contracts.js";
import { z } from "zod";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validateServerInstallOwnership } from "./installationOwnership.js";
import { isMikikoServerRootPath, resolveServerLayout } from "./paths.js";

export const supportedServerTargets = [
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
] as const;

export type ServerTarget = (typeof supportedServerTargets)[number];

export interface ServerRuntimeManifest {
  product: "mikiko-server";
  target: ServerTarget;
  appVersion: string;
  nodeVersion: string;
  entrypoints: { cli: string; core: string; agent: string };
  native: string[];
  tools?: string[];
  plugins?: string[];
  components?: Array<{
    id: string;
    sha256: string;
    paths: string[];
    sizeBytes: number;
    archivePath?: string;
  }>;
}

export const serverRuntimeManifestSchema = z
  .object({
    product: z.literal("mikiko-server"),
    target: z.enum(supportedServerTargets),
    appVersion: z.string().min(1),
    nodeVersion: z.string().min(1),
    entrypoints: z.object({ cli: z.string(), core: z.string(), agent: z.string() }).strict(),
    native: z.array(z.string()),
    tools: z.array(z.string()).optional(),
    plugins: z.array(z.string()).optional(),
    components: z
      .array(
        z
          .object({
            id: z.string().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
            paths: z.array(z.string().min(1)).min(1),
            sizeBytes: z.number().int().nonnegative(),
            archivePath: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/** 已安装磁盘元数据的读取边界；新 archive/网络 manifest 必须继续用严格 schema。 */
export async function readInstalledRuntimeManifest(
  releaseDir: string,
): Promise<ServerRuntimeManifest> {
  let value: unknown = JSON.parse(await readFile(join(releaseDir, "manifest.json"), "utf8"));
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "product" in value &&
    value.product === "zcode-server"
  ) {
    const serverRoot = await realpath(dirname(dirname(releaseDir)));
    const canonicalReleaseDir = await realpath(releaseDir);
    if (
      isMikikoServerRootPath(serverRoot) &&
      dirname(canonicalReleaseDir) === join(serverRoot, "releases")
    ) {
      // 仅兼容自有根内已有且持有合法 ownership 的旧 custom release；旧文件仍参与原始字节哈希。
      await validateServerInstallOwnership(resolveServerLayout(serverRoot));
      value = { ...value, product: "mikiko-server" };
    }
  }
  return serverRuntimeManifestSchema.parse(value);
}

export function currentServerTarget(): ServerTarget {
  const target = `${platform}-${arch}`;
  if (!supportedServerTargets.includes(target as ServerTarget)) {
    throw new Error(`Unsupported Mikiko Server target: ${target}`);
  }
  return target as ServerTarget;
}

export function createRuntimeManifest(
  target = currentServerTarget(),
  appVersion = "0.0.0-dev",
  extras: Pick<ServerRuntimeManifest, "tools" | "plugins" | "components"> = {},
): ServerRuntimeManifest {
  return {
    product: "mikiko-server",
    target,
    appVersion,
    nodeVersion: SERVER_RUNTIME_NODE_VERSION,
    // 入口是 ESM `.js`（tsup 产物）：server-cli 通过 `new URL("./server-core.js")` fork Core、
    // 通过同目录 mikiko.cjs 委派既有 CLI，三者必须同目录且文件名与产物一致。
    entrypoints: {
      cli: "runtime/server-cli.js",
      core: "runtime/server-core.js",
      agent: "runtime/mikiko.cjs",
    },
    native: ["node-pty"],
    ...extras,
  };
}
