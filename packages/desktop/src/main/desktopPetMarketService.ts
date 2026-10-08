import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  BUILTIN_PETS,
  PET_BUILTIN_CDN_BASE,
  PET_MARKET_PREVIEW_URL,
  isWebp,
  PET_MARKET_DEFAULT_RAW_BASE,
  PET_MARKET_FILES,
  buildPetMarketUrl,
  marketCategorySchema,
  marketInstallManifestSchema,
  marketPetEntrySchema,
  normalizePetManifest,
  type InstalledPetInfo,
  type MarketCategory,
  type MarketInstallManifest,
  type MarketPetEntry,
  type PetMarketCatalogResult,
} from "@zcode/shared";
import {
  INSTALL_RECORD_FILE,
  PET_MANIFEST_FILE,
  PET_SHEET_FILE,
  directoryContainsSymlinkOrExtraFiles,
  loadInstalledPetFromDir,
  sha256Hex,
  type InstalledPetRecord,
} from "./petPackIo.js";

/**
 * 宠物市场服务（specs/desktop/desktop-pet.md）：目录缓存/安装（SHA-256 校验+暂存切换）/
 * 卸载/Codex 只读导入/更新比对。网络与文件 IO 全部依赖注入，可在 node:test 下脱离 Electron 覆盖。
 * 运行时只被 desktop main 实例化；renderer 一律经 IPC 访问。本地包扫描在 petPackIo.ts。
 */

export interface PetMarketServiceDeps {
  fetchText: (url: string) => Promise<string>;
  fetchBytes: (url: string) => Promise<Uint8Array>;
  /** 宠物安装根目录（~/.mikiko/v2/pets）。 */
  petRootDir: () => string;
  /** Codex 宠物目录候选（CODEX_HOME、~/.codex、macOS App Support），存在的都扫描。 */
  codexPetsDirs: () => string[];
  /** 读取图片像素尺寸（main 用 Electron nativeImage；测试注入桩）。 */
  readImageSize: (bytes: Uint8Array) => { width: number; height: number };
  /** 市场源覆盖（镜像）；缺省官方 raw base。 */
  rawBase?: () => string;
  /** 与 desktop main logger 同形（warn/info(message, data)）；测试可省略。 */
  logger?: {
    warn: (message: string, data?: unknown) => void;
    info?: (message: string, data?: unknown) => void;
  };
}

interface CachedCatalog {
  pets: MarketPetEntry[];
  categories: MarketCategory[];
  manifest: MarketInstallManifest;
  fetchedAt: string;
}

export interface PetMarketService {
  listInstalled(): InstalledPetInfo[];
  getCatalog(options?: { refresh?: boolean }): Promise<PetMarketCatalogResult>;
  install(petId: string, force: boolean): Promise<{ ok: boolean; error?: string }>;
  uninstall(petId: string): { ok: boolean; error?: string };
  importFromCodex(): { imported: string[]; skipped: { petId: string; reason: string }[] };
  getPreviewDataUrl(petId: string): Promise<{ dataUrl?: string; error?: string }>;
  /** 读取一只本地宠物的原始清单与目录（宠物窗口渲染用）；缺失返回 null。 */
  loadLocalPet(petId: string): { manifest: unknown; petDir: string } | null;
  /** 首次使用时从 Codex 官方 CDN 预置内置宠物；本地已有任意宠物则跳过。 */
  ensureBuiltinPets(): Promise<string[]>;
}

export function createPetMarketService(deps: PetMarketServiceDeps): PetMarketService {
  const logWarn = (message: string, data?: unknown) => deps.logger?.warn(message, data);
  const rawBase = () => deps.rawBase?.() ?? PET_MARKET_DEFAULT_RAW_BASE;
  let cachedCatalog: CachedCatalog | undefined;

  const fetchJson = async <T>(url: string, schema: { parse(value: unknown): T }): Promise<T> =>
    schema.parse(JSON.parse(await deps.fetchText(url)));

  const ensureCatalog = async (): Promise<CachedCatalog> => {
    if (cachedCatalog) return cachedCatalog;
    const base = rawBase();
    const [pets, categories, manifest] = await Promise.all([
      fetchJson(buildPetMarketUrl(base, PET_MARKET_FILES.catalog), z.array(marketPetEntrySchema)),
      fetchJson(
        buildPetMarketUrl(base, PET_MARKET_FILES.categories),
        z.array(marketCategorySchema),
      ),
      fetchJson(
        buildPetMarketUrl(base, PET_MARKET_FILES.installManifest),
        marketInstallManifestSchema,
      ),
    ]);
    cachedCatalog = { pets, categories, manifest, fetchedAt: new Date().toISOString() };
    return cachedCatalog;
  };

  const writeRecord = (petDir: string, record: InstalledPetRecord) => {
    writeFileSync(join(petDir, INSTALL_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
  };

  return {
    listInstalled(): InstalledPetInfo[] {
      const root = deps.petRootDir();
      if (!existsSync(root)) return [];
      const result: InstalledPetInfo[] = [];
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const loaded = loadInstalledPetFromDir(
          join(root, entry.name),
          entry.name,
          deps.readImageSize,
        );
        if (!loaded) continue;
        // 与远端 manifest 比对更新态；目录未拉取时不标注。
        const remote = cachedCatalog?.manifest.pets[loaded.info.id];
        if (remote) {
          loaded.info.updatable =
            remote.petJsonSha256 !== loaded.petJsonSha256 ||
            remote.spritesheetSha256 !== loaded.spritesheetSha256;
        }
        result.push(loaded.info);
      }
      return result;
    },

    async getCatalog(options): Promise<PetMarketCatalogResult> {
      if (options?.refresh || !cachedCatalog) {
        cachedCatalog = undefined;
        await ensureCatalog();
      }
      const catalog = cachedCatalog!;
      return {
        pets: catalog.pets,
        categories: catalog.categories,
        fetchedAt: catalog.fetchedAt,
      };
    },

    async install(petId, force) {
      if (!/^[\w.-]+$/.test(petId)) return { ok: false, error: "invalid pet id" };
      let manifestEntry: MarketInstallManifest["pets"][string] | undefined;
      try {
        const catalog = await ensureCatalog();
        manifestEntry = catalog.manifest.pets[petId];
      } catch (error) {
        return { ok: false, error: `market catalog unavailable: ${String(error)}` };
      }
      if (!manifestEntry) return { ok: false, error: `unknown pet ${petId}` };

      const base = rawBase();
      const petDir = `pets/${petId}`;
      let petJsonBytes: Uint8Array;
      let sheetBytes: Uint8Array;
      try {
        [petJsonBytes, sheetBytes] = await Promise.all([
          deps.fetchBytes(buildPetMarketUrl(base, `${petDir}/${PET_MANIFEST_FILE}`)),
          deps.fetchBytes(buildPetMarketUrl(base, `${petDir}/${PET_SHEET_FILE}`)),
        ]);
      } catch (error) {
        return { ok: false, error: `download failed: ${String(error)}` };
      }
      // 官方 CLI 同款校验：字节数、SHA-256、WebP 头、尺寸与 id 一致。
      if (petJsonBytes.byteLength !== manifestEntry.petJsonBytes) {
        return { ok: false, error: "pet.json size mismatch" };
      }
      if (sha256Hex(petJsonBytes) !== manifestEntry.petJsonSha256) {
        return { ok: false, error: "pet.json checksum mismatch" };
      }
      if (sheetBytes.byteLength !== manifestEntry.spritesheetBytes) {
        return { ok: false, error: "spritesheet size mismatch" };
      }
      if (sha256Hex(sheetBytes) !== manifestEntry.spritesheetSha256) {
        return { ok: false, error: "spritesheet checksum mismatch" };
      }
      if (!isWebp(sheetBytes)) return { ok: false, error: "spritesheet is not WebP" };
      const size = deps.readImageSize(sheetBytes);
      if (
        size.width !== manifestEntry.spritesheetWidth ||
        size.height !== manifestEntry.spritesheetHeight
      ) {
        return { ok: false, error: "spritesheet dimensions mismatch" };
      }
      const normalized = normalizePetManifest({
        manifest: JSON.parse(new TextDecoder().decode(petJsonBytes)),
        fallbackId: petId,
        sheetWidth: size.width,
        sheetHeight: size.height,
      });
      if (!normalized.ok) return { ok: false, error: normalized.error };
      if (normalized.pet.id !== petId) {
        return { ok: false, error: `pet.json id ${normalized.pet.id} does not match ${petId}` };
      }

      const root = deps.petRootDir();
      const target = join(root, petId);
      await mkdir(root, { recursive: true });
      if (existsSync(target)) {
        if (!force) return { ok: false, error: "already installed" };
        if (directoryContainsSymlinkOrExtraFiles(target)) {
          return { ok: false, error: "existing pet directory contains unexpected entries" };
        }
      }

      // 暂存目录写完整文件后原子切换；submission.json 尽力而为（作者/许可展示用）。
      const staging = await mkdtemp(join(tmpdir(), `mikiko-pet-${petId}-`));
      const backup = join(root, `.${petId}.backup-${Date.now()}`);
      try {
        await writeFile(join(staging, PET_MANIFEST_FILE), petJsonBytes);
        await writeFile(join(staging, PET_SHEET_FILE), sheetBytes);
        writeRecord(staging, {
          installedFrom: "market",
          installedAt: new Date().toISOString(),
          petJsonSha256: manifestEntry.petJsonSha256,
          spritesheetSha256: manifestEntry.spritesheetSha256,
          spriteVersionNumber: manifestEntry.spriteVersionNumber ?? 1,
        });
        try {
          const submission = await deps.fetchText(
            buildPetMarketUrl(base, `${petDir}/submission.json`),
          );
          await writeFile(join(staging, "submission.json"), submission);
        } catch {
          // submission 是投稿元数据，缺失不影响运行时。
        }
        if (existsSync(target)) await rename(target, backup);
        try {
          await rename(staging, target);
        } catch (error) {
          if (existsSync(backup) && !existsSync(target)) await rename(backup, target);
          throw error;
        }
        await rm(backup, { recursive: true, force: true }).catch(() => undefined);
        return { ok: true };
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        logWarn("[pet-market] install failed", { petId, error: String(error) });
        return { ok: false, error: `install failed: ${String(error)}` };
      }
    },

    uninstall(petId) {
      if (!/^[\w.-]+$/.test(petId)) return { ok: false, error: "invalid pet id" };
      const target = join(deps.petRootDir(), petId);
      if (!existsSync(target)) return { ok: false, error: "not installed" };
      if (directoryContainsSymlinkOrExtraFiles(target)) {
        return { ok: false, error: "pet directory contains unexpected entries" };
      }
      try {
        rmSync(target, { recursive: true, force: true });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },

    importFromCodex() {
      const codexDirs = deps.codexPetsDirs().filter((dir) => existsSync(dir));
      if (codexDirs.length === 0) return { imported: [], skipped: [] };
      const imported: string[] = [];
      const skipped: { petId: string; reason: string }[] = [];
      const root = deps.petRootDir();
      // 逐候选目录扫描；同一 id 首个命中生效，后续目录按 already installed 跳过。
      const candidates: Array<{ sourceDir: string; petId: string }> = [];
      for (const codexDir of codexDirs) {
        for (const entry of readdirSync(codexDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            candidates.push({ sourceDir: join(codexDir, entry.name), petId: entry.name });
          }
        }
      }
      for (const { sourceDir, petId: candidateId } of candidates) {
        const loaded = loadInstalledPetFromDir(sourceDir, candidateId, deps.readImageSize);
        if (!loaded) {
          skipped.push({ petId: candidateId, reason: "invalid pack" });
          continue;
        }
        if (existsSync(join(root, loaded.info.id))) {
          skipped.push({ petId: loaded.info.id, reason: "already installed" });
          continue;
        }
        // 复制而非链接：Codex 目录保持只读，Mikiko 侧拥有自己的副本。
        try {
          const targetDir = join(root, loaded.info.id);
          mkdirSync(targetDir, { recursive: true });
          copyFileSync(join(sourceDir, PET_MANIFEST_FILE), join(targetDir, PET_MANIFEST_FILE));
          copyFileSync(join(sourceDir, PET_SHEET_FILE), join(targetDir, PET_SHEET_FILE));
          writeRecord(targetDir, {
            installedFrom: "codex-import",
            installedAt: new Date().toISOString(),
            petJsonSha256: loaded.petJsonSha256,
            spritesheetSha256: loaded.spritesheetSha256,
            spriteVersionNumber: loaded.info.spriteVersionNumber,
          });
          imported.push(loaded.info.id);
        } catch (error) {
          skipped.push({ petId: loaded.info.id, reason: String(error) });
        }
      }
      return { imported, skipped };
    },

    async getPreviewDataUrl(petId) {
      if (!/^[\w.-]+$/.test(petId)) return { error: "invalid pet id" };
      try {
        const bytes = await deps.fetchBytes(PET_MARKET_PREVIEW_URL(petId));
        if (!isWebp(bytes)) return { error: "preview is not WebP" };
        return { dataUrl: `data:image/webp;base64,${Buffer.from(bytes).toString("base64")}` };
      } catch (error) {
        return { error: `preview unavailable: ${String(error)}` };
      }
    },

    loadLocalPet(petId) {
      if (!/^[\w.-]+$/.test(petId)) return null;
      const petDir = join(deps.petRootDir(), petId);
      const manifestPath = join(petDir, PET_MANIFEST_FILE);
      if (!existsSync(manifestPath)) return null;
      try {
        return { manifest: JSON.parse(readFileSync(manifestPath, "utf8")), petDir };
      } catch {
        return null;
      }
    },

    async ensureBuiltinPets(): Promise<string[]> {
      const root = deps.petRootDir();
      // 已有任意宠物（含用户自装/导入）即不预置，避免覆盖用户选择。
      if (existsSync(root) && readdirSync(root).some((name) => !name.startsWith("."))) return [];
      const imported: string[] = [];
      await mkdir(root, { recursive: true });
      for (const builtin of BUILTIN_PETS) {
        if (existsSync(join(root, builtin.id))) continue;
        try {
          const sheetBytes = await deps.fetchBytes(
            `${PET_BUILTIN_CDN_BASE}/${builtin.spritesheetFile}`,
          );
          if (sheetBytes.byteLength === 0 || sheetBytes.byteLength > 8 * 1024 * 1024) {
            throw new Error(`unexpected size ${sheetBytes.byteLength}`);
          }
          if (!isWebp(sheetBytes)) throw new Error("not WebP");
          const size = deps.readImageSize(sheetBytes);
          const normalized = normalizePetManifest({
            manifest: {
              id: builtin.id,
              displayName: builtin.displayName,
              description: builtin.description,
            },
            fallbackId: builtin.id,
            sheetWidth: size.width,
            sheetHeight: size.height,
          });
          if (!normalized.ok) throw new Error(normalized.error);
          const staging = await mkdtemp(join(tmpdir(), `mikiko-pet-builtin-`));
          try {
            const manifest = {
              id: builtin.id,
              displayName: builtin.displayName,
              description: builtin.description,
              spritesheetPath: PET_SHEET_FILE,
            };
            await writeFile(join(staging, PET_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
            await writeFile(join(staging, PET_SHEET_FILE), sheetBytes);
            writeRecord(staging, {
              installedFrom: "builtin",
              installedAt: new Date().toISOString(),
              petJsonSha256: sha256Hex(new TextEncoder().encode(JSON.stringify(manifest))),
              spritesheetSha256: sha256Hex(sheetBytes),
              spriteVersionNumber: 1,
            });
            await rename(staging, join(root, builtin.id));
            imported.push(builtin.id);
          } catch (error) {
            await rm(staging, { recursive: true, force: true }).catch(() => undefined);
            throw error;
          }
        } catch (error) {
          // 单只失败不影响其余；首次启动无网时静默跳过（用户仍可市场安装/导入）。
          logWarn("[pet-market] builtin provision failed", {
            id: builtin.id,
            error: String(error),
          });
        }
      }
      if (imported.length > 0)
        deps.logger?.info?.("[pet-market] builtin pets provisioned", { count: imported.length });
      return imported;
    },
  };
}
