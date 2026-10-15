import { z } from "zod";
import {
  THEME_SKIN_DESCRIPTION_MAX_LENGTH,
  THEME_SKIN_NAME_MAX_LENGTH,
  isThemeSkinColorValue,
  isThemeSkinTokenName,
} from "./tokens.js";

/**
 * 皮肤文件/记录校验（specs/ui/theme-skins.md §3）。
 * 导入路径信任度低：除 zod 结构外，token 白名单与颜色语法逐项校验，越界即整体拒绝。
 */

const tokenMapSchema = z.record(z.string(), z.string()).superRefine((map, ctx) => {
  for (const [name, value] of Object.entries(map)) {
    if (!isThemeSkinTokenName(name)) {
      ctx.addIssue({ code: "custom", message: `token not allowed: ${name}` });
      return;
    }
    if (!isThemeSkinColorValue(value)) {
      ctx.addIssue({
        code: "custom",
        message: `invalid color value for ${name}`,
      });
      return;
    }
  }
});

const wallpaperCommonSchema = z.object({
  fit: z.enum(["cover", "contain"]),
  blurPx: z.number().int().min(0).max(24),
  dimPercentLight: z.number().int().min(0).max(100),
  dimPercentDark: z.number().int().min(0).max(100),
});

const cssWallpaperSchema = z.intersection(
  wallpaperCommonSchema,
  z.object({
    kind: z.literal("css"),
    // background 简写兼容值：渐变函数与颜色，禁止 url()/引号外字符（防注入）。
    css: z
      .string()
      .min(1)
      .max(1200)
      .refine(
        (value) => /^[-\w ,()%#.\/]+$/.test(value) && !/url\(/i.test(value),
        "css wallpaper must be a plain gradient/color expression without url()",
      ),
  }),
);

const exportImageWallpaperSchema = z.intersection(
  wallpaperCommonSchema,
  z.object({
    kind: z.literal("image"),
    dataUrl: z.string().regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
  }),
);

const fileImageWallpaperSchema = z.intersection(
  wallpaperCommonSchema,
  z.object({
    kind: z.literal("image"),
    file: z.string().regex(/^[\w.-]+$/),
  }),
);

const metaSchema = z.object({
  name: z.string().trim().min(1).max(THEME_SKIN_NAME_MAX_LENGTH),
  description: z.string().max(THEME_SKIN_DESCRIPTION_MAX_LENGTH).optional(),
  author: z.string().max(60).optional(),
  version: z.string().max(20).optional(),
});

/** .mikikotheme 导入文件 schema。 */
export const themeSkinExportFileSchema = z.intersection(
  metaSchema,
  z.object({
    format: z.literal("mikiko-theme-skin"),
    formatVersion: z.literal(1),
    light: tokenMapSchema,
    dark: tokenMapSchema,
    wallpaper: z.union([cssWallpaperSchema, exportImageWallpaperSchema]).optional(),
  }),
);

/** theme.json（磁盘记录）schema。 */
export const themeSkinRecordSchema = z.intersection(
  metaSchema.extend({ version: z.string().min(1).max(20) }),
  z.object({
    format: z.literal("mikiko-theme-skin-record"),
    formatVersion: z.literal(1),
    id: z.string().regex(/^[\w.-]+$/),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    light: tokenMapSchema,
    dark: tokenMapSchema,
    wallpaper: z.union([cssWallpaperSchema, fileImageWallpaperSchema]).optional(),
  }),
);

export type ThemeSkinExportFileInput = z.infer<typeof themeSkinExportFileSchema>;
export type ThemeSkinRecordInput = z.infer<typeof themeSkinRecordSchema>;
