import type { PluginDiagnostic } from "@zcode/contracts";
import type { PluginAbortOptions } from "./types.js";
import { throwIfAborted, isNotFoundError } from "./helpers.js";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

const BUNDLED_PARTITION_FILE = "bundled-marketplace.json";
const CDN_PARTITION_FILE = "cdn-marketplace.json";
const MERGED_MARKETPLACE_FILE = "marketplace.json";

interface BundledMarketplacePartition {
  manifest: Record<string, unknown>;
  version: 1;
}

export function writeBundledOfficialMarketplacePartitionSync(input: {
  manifest: Record<string, unknown>;
  storageRoot: string;
}): Record<string, unknown> {
  assertOfficialManifest(input.manifest);
  writeJsonFileSync(partitionPath(input.storageRoot, BUNDLED_PARTITION_FILE), {
    manifest: input.manifest,
    version: 1,
  } satisfies BundledMarketplacePartition);
  return rebuildOfficialMarketplaceSync(input.storageRoot);
}

export function writeCdnOfficialMarketplacePartitionSync(input: {
  manifest: Record<string, unknown>;
  storageRoot: string;
}): Record<string, unknown> {
  assertOfficialManifest(input.manifest);
  writeJsonFileSync(partitionPath(input.storageRoot, CDN_PARTITION_FILE), input.manifest);
  return rebuildOfficialMarketplaceSync(input.storageRoot);
}

export function loadBundledOfficialPluginRootsSync(storageRoot: string): string[] | undefined {
  const bundledPartition = readBundledPartition(storageRoot);
  if (!bundledPartition) return undefined;

  const officialCacheRoot = resolve(storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  return readPluginEntries(bundledPartition.manifest).flatMap((plugin) => {
    const name = readPluginName(plugin);
    const cachePath = typeof plugin.cachePath === "string" ? plugin.cachePath : undefined;
    if (!name || !cachePath) return [];

    const pluginCacheRoot = resolve(officialCacheRoot, name);
    const resolvedCachePath = resolve(cachePath);
    if (
      !isStrictDescendant(officialCacheRoot, pluginCacheRoot) ||
      !isStrictDescendant(pluginCacheRoot, resolvedCachePath)
    ) {
      return [];
    }
    return [resolvedCachePath];
  });
}

function rebuildOfficialMarketplaceSync(storageRoot: string): Record<string, unknown> {
  const bundledPartition = readBundledPartition(storageRoot);
  const cdnManifest = readJsonRecord(partitionPath(storageRoot, CDN_PARTITION_FILE));
  const bundledManifest = bundledPartition?.manifest;
  const cdnPlugins = readPluginEntries(cdnManifest);
  const cdnPluginNames = new Set(cdnPlugins.map(readPluginName).filter(isDefined));
  const bundledPlugins = readPluginEntries(bundledManifest).filter((plugin) => {
    const name = readPluginName(plugin);
    return name !== undefined && !cdnPluginNames.has(name);
  });

  // 内置插件与 CDN 插件曾使用两个 marketplace id，UI 会把内置市场当成
  // 无 source 的独立市场并在刷新时报 not found。两个分片必须独立持久化后再合并，
  // 否则应用启动时的 seed 会覆盖 CDN 目录，或 CDN 刷新会覆盖内置目录。同名时以
  // 可刷新的 CDN 市场条目为准，但只过滤合并目录，不删除应用内置缓存。
  const merged = {
    ...(bundledManifest ?? {}),
    ...(cdnManifest ?? {}),
    name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    plugins: [...cdnPlugins, ...bundledPlugins],
  };
  writeJsonFileSync(partitionPath(storageRoot, MERGED_MARKETPLACE_FILE), merged);
  return merged;
}

function readBundledPartition(storageRoot: string): BundledMarketplacePartition | undefined {
  const value = readJsonRecord(partitionPath(storageRoot, BUNDLED_PARTITION_FILE));
  if (!value || value.version !== 1 || !isRecord(value.manifest)) return undefined;
  return {
    manifest: value.manifest,
    version: 1,
  };
}

function readPluginEntries(
  manifest: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  return Array.isArray(manifest?.plugins) ? manifest.plugins.filter(isRecord) : [];
}

function readPluginName(plugin: Record<string, unknown>): string | undefined {
  return typeof plugin.name === "string" && plugin.name.length > 0 ? plugin.name : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isStrictDescendant(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath);
  return (
    relativePath.length > 0 &&
    !isAbsolute(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`)
  );
}

function assertOfficialManifest(manifest: Record<string, unknown>): void {
  if (manifest.name !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
    throw new Error(
      `Official marketplace manifest must be named ${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    );
  }
}

function partitionPath(storageRoot: string, fileName: string): string {
  return join(storageRoot, "marketplaces", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, fileName);
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeJsonFileSync(path: string, value: unknown): void {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    // 官方目录在每次启动都会重建；同内容反复写盘会增加 Windows 上
    // marketplace 文件被杀毒/索引器占用的概率。只跳过字节完全相同的单文件写入，
    // 读取失败或内容变化仍执行写入并保留原有失败语义。
    if (readFileSync(path, "utf8") === contents) return;
  } catch {
    // 文件不存在或暂时不可读时继续写，让真实更新失败继续向调用方暴露。
  }
  writeFileSync(path, contents, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function scanOfficialCache(
  storageRoot: string,
  diagnostics: PluginDiagnostic[],
  options?: PluginAbortOptions,
): string[] {
  // 官方插件升级会保留旧版本缓存目录；若遍历全部目录再按插件 id
  // “先到先得”，旧版本会抢在 bundled marketplace 指向的当前版本前被加载。
  // bundled 分片是当前随应用发布资产的权威清单；存在时只加载其 cachePath。
  // 不能简单选择最高 semver，否则官方回滚版本时仍会错误加载旧缓存。
  const bundledRoots = loadBundledOfficialPluginRootsSync(storageRoot);
  if (bundledRoots !== undefined) {
    for (const rootPath of bundledRoots) {
      throwIfAborted(options);
    }
    return bundledRoots;
  }

  const cacheRoot = join(storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  try {
    const roots: string[] = [];
    for (const pluginEntry of readdirSync(cacheRoot, { withFileTypes: true })) {
      throwIfAborted(options);
      if (!pluginEntry.isDirectory()) continue;
      const pluginDir = join(cacheRoot, pluginEntry.name);
      for (const versionEntry of readdirSync(pluginDir, { withFileTypes: true })) {
        if (versionEntry.isDirectory()) roots.push(join(pluginDir, versionEntry.name));
      }
    }
    return roots;
  } catch (error) {
    if (isNotFoundError(error)) return [];
    diagnostics.push({
      code: "plugin_root_not_found",
      message: error instanceof Error ? error.message : `Failed to scan ${cacheRoot}`,
      path: cacheRoot,
      severity: "warning",
    });
    return [];
  }
}
