import { z } from "zod";

/**
 * 宠物市场（legeling/awesome-codex-pet）协议：目录 schema（passthrough，第三方字段持续演进）、
 * 安装清单、搜索与源 URL 构造（specs/desktop/desktop-pet.md）。从 pets.ts 拆出控制行数。
 */

export const PET_MARKET_DEFAULT_RAW_BASE =
  "https://raw.githubusercontent.com/legeling/awesome-codex-pet/main";
export const PET_MARKET_FILES = {
  catalog: "pets.json",
  installManifest: "install-manifest.json",
  categories: "categories.json",
} as const;
/**
 * 预览图只在展示站上（GitHub 仓库的 assets/previews 是 CI 构建产物，raw 路径 404）。
 * idle.webp 是动画 WebP（浏览器 <img> 直接播放）。
 */
export const PET_PREVIEW_SITE_BASE = "https://codexpet.top";
export const PET_MARKET_PREVIEW_URL = (petId: string) =>
  `${PET_PREVIEW_SITE_BASE}/assets/previews/${petId}/webp/idle.webp`;

/** Codex 官方内置宠物（persistent.oaistatic.com，v4 图集=1536x1872 九行网格）。 */
export const PET_BUILTIN_CDN_BASE = "https://persistent.oaistatic.com/codex/pets/v1";
export const BUILTIN_PETS: readonly {
  id: string;
  displayName: string;
  description: string;
  spritesheetFile: string;
}[] = [
  {
    id: "codex",
    displayName: "Codex",
    description: "The original Codex companion",
    spritesheetFile: "codex-spritesheet-v4.webp",
  },
  {
    id: "dewey",
    displayName: "Dewey",
    description: "A tidy duck for calm workspace days",
    spritesheetFile: "dewey-spritesheet-v4.webp",
  },
  {
    id: "fireball",
    displayName: "Fireball",
    description: "Hot path energy for fast iteration",
    spritesheetFile: "fireball-spritesheet-v4.webp",
  },
  {
    id: "rocky",
    displayName: "Rocky",
    description: "A steady rock when the diff gets large",
    spritesheetFile: "rocky-spritesheet-v4.webp",
  },
];

export const marketLocalizedNamesSchema = z
  .object({ en: z.string().optional(), zh: z.string().optional() })
  .strict();
export type MarketLocalizedNames = z.infer<typeof marketLocalizedNamesSchema>;

export const marketPetEntrySchema = z
  .object({
    slug: z.string().min(1),
    name: z.string(),
    localized_names: marketLocalizedNamesSchema.optional(),
    author: z.string().optional(),
    author_handle: z.string().optional(),
    author_url: z.string().optional(),
    primary_category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    collections: z.array(z.string()).optional(),
    license: z.string().optional(),
    description: z.string().optional(),
    spriteVersionNumber: z.number().int().optional(),
    // 第三方目录字段持续演进（canonical_key/variant_note 等，305 只中 175 只带额外键），
    // 已知字段强类型 + passthrough：未知键保留不拒绝，避免整目录加载失败。
  })
  .passthrough();
export type MarketPetEntry = z.infer<typeof marketPetEntrySchema>;

export const marketCategorySchema = z
  .object({
    slug: z.string().min(1),
    name: z.string(),
    label: z.record(z.string(), z.string()).optional(),
    description: z.record(z.string(), z.string()).optional(),
    // discoverable 等运营字段随目录演进；passthrough 同上。
  })
  .passthrough();
export type MarketCategory = z.infer<typeof marketCategorySchema>;

export const marketInstallManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: z.string(),
    ref: z.string(),
    pets: z.record(
      z.string(),
      z
        .object({
          name: z.string(),
          localizedNames: marketLocalizedNamesSchema.optional(),
          spriteVersionNumber: z.number().int().optional(),
          petJsonSha256: z.string().length(64),
          petJsonBytes: z.number().int().nonnegative(),
          spritesheetSha256: z.string().length(64),
          spritesheetBytes: z.number().int().nonnegative(),
          spritesheetWidth: z.number().int().positive(),
          spritesheetHeight: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();
export type MarketInstallManifest = z.infer<typeof marketInstallManifestSchema>;

/** 多关键词 AND 搜索：匹配 slug / 默认名 / 双语名 / 作者 / 标签（对齐官方 CLI search 语义）。 */
export function searchMarketPets(
  entries: readonly MarketPetEntry[],
  query: string,
): MarketPetEntry[] {
  const keywords = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((keyword) => keyword.length > 0);
  if (keywords.length === 0) return [...entries];
  return entries.filter((entry) => {
    const haystack = [
      entry.slug,
      entry.name,
      entry.localized_names?.en ?? "",
      entry.localized_names?.zh ?? "",
      entry.author ?? "",
      entry.author_handle ?? "",
      ...(entry.tags ?? []),
    ]
      .join("\n")
      .toLowerCase();
    return keywords.every((keyword) => haystack.includes(keyword));
  });
}

/** 市场源 URL 构造：只允许无凭据/无查询/无片段的 HTTPS 基址。 */
export function buildPetMarketUrl(rawBase: string, filePath: string): string {
  const base = rawBase.trim().replace(/\/+$/, "");
  const parsed = new URL(`${base}/${filePath.replace(/^\/+/, "")}`);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("pet market raw base must be a credential-free HTTPS URL");
  }
  return parsed.toString();
}

/** 市场目录拉取结果（renderer 设置页消费）。 */
export interface PetMarketCatalogResult {
  pets: MarketPetEntry[];
  categories: MarketCategory[];
  /** 已缓存时为上次拉取时间；refresh=true 强制重拉。 */
  fetchedAt: string;
}
