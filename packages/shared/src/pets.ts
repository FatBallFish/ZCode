import { z } from "zod";

/**
 * Mikiko 桌面宠物（specs/desktop/desktop-pet.md）。
 *
 * 包格式与校验规则对齐 openai/codex 的 codex-rs/tui/src/pets/model.rs：
 * 网格缺省 192x208 帧、8 列；行数由图集高度推导（1872→v1 九行 / 2288→v2 十一行）；
 * 动作表缺省值、覆盖合并与越界校验同款。市场协议对齐 legeling/awesome-codex-pet。
 */

export const PET_FRAME_WIDTH = 192;
export const PET_FRAME_HEIGHT = 208;
export const PET_FRAME_COLUMNS = 8;
export const PET_SPRITESHEET_WIDTH = PET_FRAME_WIDTH * PET_FRAME_COLUMNS;
/** v1 图集高度：8 列 × 9 行（标准动作）。 */
export const PET_V1_SPRITESHEET_HEIGHT = PET_FRAME_HEIGHT * 9;
/** v2 图集高度：8 列 × 11 行（追加 16 个顺时针环视帧）。 */
export const PET_V2_SPRITESHEET_HEIGHT = PET_FRAME_HEIGHT * 11;
export const PET_MAX_FRAMES = 256;
export const PET_MAX_ANIMATION_FPS = 60;
export const PET_DEFAULT_ANIMATION_FPS = 8;

// ---------------------------------------------------------------------------
// pet.json
// ---------------------------------------------------------------------------

export const petAnimationSpecSchema = z
  .object({
    frames: z.array(z.number().int().nonnegative()),
    fps: z.number().positive().max(PET_MAX_ANIMATION_FPS).optional(),
    loop: z.boolean().optional(),
    fallback: z.string().optional(),
  })
  .strict();
export type PetAnimationSpec = z.infer<typeof petAnimationSpecSchema>;

export const petFrameSpecSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
  })
  .strict();
export type PetFrameSpec = z.infer<typeof petFrameSpecSchema>;

export const petManifestSchema = z
  .object({
    id: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    spritesheetPath: z.string().optional(),
    frame: petFrameSpecSchema.optional(),
    animations: z.record(z.string(), petAnimationSpecSchema).optional(),
    /** 市场侧在 install-manifest 标注；包内携带时只做冗余校验。 */
    spriteVersionNumber: z.number().int().optional(),
  })
  .strict();
export type PetManifest = z.infer<typeof petManifestSchema>;

export interface NormalizedPetAnimationFrame {
  spriteIndex: number;
  durationMs: number;
}
export interface NormalizedPetAnimation {
  frames: NormalizedPetAnimationFrame[];
  loop: boolean;
  fallback: string;
}
export interface NormalizedPet {
  id: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  frameCount: number;
  animations: Record<string, NormalizedPetAnimation>;
}

/** 缺省动作表：行号 → 帧序列与时长（对齐 Codex default_animations）。 */
export const DEFAULT_PET_ANIMATIONS: Readonly<Record<string, NormalizedPetAnimation>> = (() => {
  const track = (
    row: number,
    count: number,
    frameMs: number,
    finalMs: number,
    loop = true,
    repeats = 1,
  ) => {
    const primary = Array.from({ length: count }, (_, index) => ({
      spriteIndex: row * PET_FRAME_COLUMNS + index,
      durationMs: index === count - 1 ? finalMs : frameMs,
    }));
    // 一次性动作主序列×3 再回落 idle：对齐官方 app_state_animation 的
    // primary×3 + idle 尾巴 + loop_start 帧序列（fallback=idle 等价实现尾巴）。
    return {
      frames: Array.from({ length: repeats }, () => primary).flat(),
      loop,
      fallback: "idle",
    };
  };
  return {
    // 官方 idle_animation 逐帧对齐：只用第 0 行前 6 格（官方图集第 6/7 格为空白，
    // 之前按 8 帧循环会周期性画到空格子——宠物/预览「闪烁」的根因），时长为呼吸节奏。
    idle: {
      frames: [
        { spriteIndex: 0, durationMs: 1680 },
        { spriteIndex: 1, durationMs: 660 },
        { spriteIndex: 2, durationMs: 660 },
        { spriteIndex: 3, durationMs: 840 },
        { spriteIndex: 4, durationMs: 840 },
        { spriteIndex: 5, durationMs: 1920 },
      ],
      loop: true,
      fallback: "idle",
    },
    "running-right": track(1, 8, 120, 220),
    "running-left": track(2, 8, 120, 220),
    waving: track(3, 4, 140, 280, false, 3),
    jumping: track(4, 5, 140, 280, false, 3),
    failed: track(5, 8, 140, 240),
    waiting: track(6, 6, 150, 260),
    running: track(7, 6, 120, 220),
    review: track(8, 6, 150, 280),
    move_right: track(1, 8, 120, 220),
    move_left: track(2, 8, 120, 220),
    wave: track(3, 4, 140, 280, false, 3),
    bounce: track(4, 5, 140, 280, false, 3),
    sad: track(5, 8, 140, 240),
    // v2：行 9–10 共 16 个顺时针环视帧，拼成一个完整环。
    look: (() => {
      const frames: NormalizedPetAnimationFrame[] = [];
      for (let row = 9; row <= 10; row += 1) {
        for (let col = 0; col < PET_FRAME_COLUMNS; col += 1) {
          frames.push({
            spriteIndex: row * PET_FRAME_COLUMNS + col,
            durationMs: 150,
          });
        }
      }
      return { frames: [...frames, ...frames.slice().reverse()], loop: false, fallback: "idle" };
    })(),
  };
})();

export type PetNormalizeResult = { ok: true; pet: NormalizedPet } | { ok: false; error: string };

/**
 * 把 pet.json + 实际图集尺寸规范化为运行时 Pet。
 * 校验：spritesheet 路径只允许包内相对子路径（防穿越，Codex 同款）；
 * 网格必须恰好覆盖图集；帧数 ≤256；动画索引越界 / fallback 缺失拒绝。
 */
export function normalizePetManifest(input: {
  manifest: unknown;
  fallbackId: string;
  sheetWidth: number;
  sheetHeight: number;
}): PetNormalizeResult {
  const parsed = petManifestSchema.safeParse(input.manifest);
  if (!parsed.success) {
    return { ok: false, error: `invalid pet.json: ${parsed.error.issues[0]?.message ?? "schema"}` };
  }
  const file = parsed.data;
  const sheetHeight = input.sheetHeight;
  const sheetWidth = input.sheetWidth;

  let frame: PetFrameSpec;
  if (file.frame) {
    frame = file.frame;
  } else {
    const rows = sheetHeight / PET_FRAME_HEIGHT;
    if (!Number.isInteger(rows) || (rows !== 9 && rows !== 11)) {
      return {
        ok: false,
        error: `unsupported spritesheet height ${sheetHeight} (expected ${PET_V1_SPRITESHEET_HEIGHT} or ${PET_V2_SPRITESHEET_HEIGHT})`,
      };
    }
    frame = { width: PET_FRAME_WIDTH, height: PET_FRAME_HEIGHT, columns: PET_FRAME_COLUMNS, rows };
  }
  if (frame.width * frame.columns !== sheetWidth || frame.height * frame.rows !== sheetHeight) {
    return {
      ok: false,
      error: `pet frame grid must cover spritesheet exactly: expected ${sheetWidth}x${sheetHeight}`,
    };
  }
  const frameCount = frame.columns * frame.rows;
  if (frameCount > PET_MAX_FRAMES) {
    return { ok: false, error: `pet frame count ${frameCount} exceeds maximum ${PET_MAX_FRAMES}` };
  }

  const spritesheetPath = file.spritesheetPath?.trim() || "spritesheet.webp";
  if (
    spritesheetPath.startsWith("/") ||
    spritesheetPath.includes("..") ||
    /^[a-zA-Z]:[\\/]/.test(spritesheetPath) ||
    spritesheetPath.includes("\\")
  ) {
    return { ok: false, error: "spritesheet path must stay inside the pet directory" };
  }

  const animations: Record<string, NormalizedPetAnimation> = Object.fromEntries(
    Object.entries(DEFAULT_PET_ANIMATIONS)
      // 默认表按图集实际帧数过滤：look 引用 v2 第 9–10 行，v1 图集（72 帧）没有这些
      // 格子。不过滤的话 v1 宠物也会带上越界 look，运行时随机会播到图集外——
      // drawImage 源矩形越界整帧不绘制，宠物每 8–16s 消失约 4.8s（闪烁根因之二）。
      .filter(([, animation]) => animation.frames.every((frame) => frame.spriteIndex < frameCount))
      .map(([name, animation]) => [
        name,
        { ...animation, frames: animation.frames.map((item) => ({ ...item })) },
      ]),
  );
  for (const [name, spec] of Object.entries(file.animations ?? {})) {
    if (spec.frames.length === 0) {
      return { ok: false, error: `animation ${name} must include at least one frame` };
    }
    for (const spriteIndex of spec.frames) {
      if (spriteIndex >= frameCount) {
        return {
          ok: false,
          error: `animation ${name} references sprite index ${spriteIndex}, but pet has ${frameCount} frames`,
        };
      }
    }
    const fps = spec.fps ?? PET_DEFAULT_ANIMATION_FPS;
    animations[name] = {
      frames: spec.frames.map((spriteIndex) => ({
        spriteIndex,
        durationMs: Math.round(1000 / fps),
      })),
      loop: spec.loop ?? true,
      fallback: spec.fallback?.trim() || "idle",
    };
  }
  if (!animations["idle"]) {
    return { ok: false, error: "pet must define an idle animation" };
  }
  for (const [name, animation] of Object.entries(animations)) {
    if (!animations[animation.fallback]) {
      return {
        ok: false,
        error: `animation ${name} fallback ${animation.fallback} does not exist`,
      };
    }
  }

  const manifestId = file.id?.trim();
  return {
    ok: true,
    pet: {
      id: manifestId && manifestId.length > 0 ? manifestId : input.fallbackId,
      displayName: file.displayName?.trim() || manifestId || input.fallbackId,
      description: file.description?.trim() ?? "",
      spritesheetPath,
      frameWidth: frame.width,
      frameHeight: frame.height,
      columns: frame.columns,
      rows: frame.rows,
      frameCount,
      animations,
    },
  };
}

// ---------------------------------------------------------------------------
// IPC 载荷类型（channels.ts 引用）
// ---------------------------------------------------------------------------

/** 已安装宠物信息（main 聚合：清单 + 安装记录 + 与远端 manifest 的更新比对）。 */
export interface InstalledPetInfo {
  id: string;
  displayName: string;
  description: string;
  spriteVersionNumber: number;
  installedFrom: "market" | "codex-import" | "builtin";
  installedAt: string;
  petJsonSha256: string;
  spritesheetSha256: string;
  /** 远端 manifest 可比对且 SHA 不一致时为 true；目录缺失远端记录时为 undefined。 */
  updatable?: boolean;
}

/** 宠物窗口挂载时读取的当前宠物视图。 */
export interface ActivePetView {
  pet: NormalizedPet;
  /** petpack:// 协议地址；页面 CSP 只允许该 scheme。 */
  spritesheetUrl: string;
  /** 窗口透明是否被降级（Linux 无合成器兜底）。 */
  opaqueFallback: boolean;
}

/** 宠物窗口状态推送（main → pet 页面；只读订阅 agent 运行态等）。
 * waiting/failed/review 由会话摘要优先级映射（specs/desktop/desktop-pet.md 会话状态气泡）。 */
export interface DesktopPetStateEvent {
  state: "idle" | "running" | "waiting" | "failed" | "review" | "waving";
}

export const DESKTOP_PET_STATE_CHANNEL = "zcode:desktop-pet-state";

/** 宠物稳态（一次性 waving 之外的派生态；PetGetActive 初始化用）。 */
export type DesktopPetSteadyState = Exclude<DesktopPetStateEvent["state"], "waving">;

// ---------------------------------------------------------------------------
// 会话状态气泡（host → main 聚合 → 气泡窗口）
// ---------------------------------------------------------------------------

/** 气泡里一个会话的展示摘要（host 从 Controller 投影行过滤映射，只读）。 */
export interface PetSessionSummary {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  title: string;
  liveStatus: "running" | "waiting" | "completed" | "error";
  /** 最后一条助手消息预览（≤120 字符，可缺省）。 */
  lastPreview?: string;
  unread: boolean;
  /** 正在等待用户处理：权限授权 / 用户输入。 */
  pendingKind?: "permission" | "userInput";
  pendingToolName?: string;
  /** 最近活动时间（多 host 合并排序用；气泡展示忽略）。 */
  updatedAt?: number;
}

/** 气泡窗口主结构：可见行 + 溢出计数 + 主题（main 按应用主题解析，页面跟随切换）。 */
export interface PetSessionBubblePayload {
  rows: PetSessionSummary[];
  overflowCount: number;
  theme: "dark" | "light";
}

export const DESKTOP_PET_BUBBLE_CHANNEL = "zcode:desktop-pet-bubble";
