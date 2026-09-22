#!/usr/bin/env node
// Mikiko 品牌资产生成工具：调用阿里云百炼 Qwen 生图模型（DashScope）。
// 用法：DASHSCOPE_API_KEY=sk-xxx node gen.mjs <brief-name>
// 提示词与 seed 在 PROMPTS 中维护，保证可复现。密钥只从环境变量读取，不落盘。
import { writeFile, mkdir } from "node:fs/promises";

const API = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const KEY = process.env.DASHSCOPE_API_KEY;
if (!KEY) {
  console.error("missing DASHSCOPE_API_KEY env");
  process.exit(1);
}

const PROMPTS = {
  // 主方案：纯黑白扁平，延续 ZCode 图标的家族语言（黑底白字形）
  "mark-flat": {
    prompt:
      "极简风格的应用图标设计，正方形满幅构图。哑光纯黑背景带从中心到边缘的微妙明暗渐变，画面中心是一个加粗的白色几何风格大写字母 M，现代主义无衬线字形，笔画简洁有力，居中，字高约占画面高度的百分之五十五。整体为圆角方形轮廓，macOS 应用图标风格。扁平矢量质感，无阴影，无描边，无渐变高光，除字母 M 外无其他任何文字或装饰元素。高对比度，边缘锐利，专业品牌图标。",
    negative_prompt: "文字, 水印, 多个字母, 阴影, 立体感, 渐变彩色, 纹理, 边框, 复杂背景",
    seed: 42,
  },
  // 变体：圆角笔画 + 轻微未来感，作为备选方向
  "mark-round": {
    prompt:
      "极简黑白应用图标，深黑色圆角方形背景，画面中心一个白色粗笔画几何大写字母 M 单字标志，笔画末端为圆角，字形微微带未来感但保持克制，背景边缘有极微妙暗角，整体扁平干净专业，居中构图，除 M 外无任何文字，无阴影，无渐变彩色，软件品牌图标。",
    negative_prompt: "文字, 水印, 多个字母, 阴影, 立体感, 渐变彩色, 纹理, 边框, 复杂背景",
    seed: 7,
  },
  // 变体：瑞士平面风格构成派，笔画等宽精确对称（与手绘 SVG 图形标同语言）
  "mark-geometric": {
    prompt:
      "极简应用图标，哑光黑色圆角方形背景，画面正中心一个白色大写字母 M 标志。这个 M 不是打字字体，而是由瑞士国际主义平面设计风格精确构成的几何图形：所有笔画是宽度完全一致的粗直线，垂直笔画与斜向笔画构成两个对称的峰，左右完全镜像对称，笔画末端为锐利直角，无任何圆角，像现代主义字体设计的字标构成。扁平矢量质感，无阴影无渐变高光，除 M 外无任何文字或装饰，高对比，边缘锐利，专业软件品牌图标。",
    negative_prompt:
      "文字, 水印, 多个字母, 圆角笔画, 连笔, 斜体, 阴影, 立体感, 渐变彩色, 纹理, 边框, 手绘感",
    seed: 11,
  },
  // DMG 安装背景：2 倍尺寸生成后由流水线缩到 540x380
  "dmg-bg": {
    prompt:
      "macOS 应用安装器 DMG 窗口背景图，极简设计：纯黑色哑光背景，画面左下角有一个极淡的半透明白色大写字母 M 巨型水印轮廓作为品牌暗示，右上区域干净留白，整体扁平，微妙暗角，无渐变彩色，无任何文字，无边框，专业软件安装背景。",
    negative_prompt: "文字, 水印字样, 按钮图样, 箭头, 图标框, 渐变彩色, 亮色, 复杂纹理",
    seed: 21,
  },
};

const name = process.argv[2];
const brief = PROMPTS[name];
if (!brief) {
  console.error(`unknown brief: ${name} (available: ${Object.keys(PROMPTS).join(", ")})`);
  process.exit(1);
}

const res = await fetch(API, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${KEY}`,
  },
  body: JSON.stringify({
    model: "qwen-image-3.0-pro",
    input: { messages: [{ role: "user", content: [{ text: brief.prompt }] }] },
    parameters: {
      size: "1024*1024",
      n: 2,
      seed: brief.seed,
      watermark: false,
      negative_prompt: brief.negative_prompt,
    },
  }),
});

const body = await res.json();
if (!res.ok) {
  console.error("API error:", res.status, JSON.stringify(body).slice(0, 800));
  process.exit(1);
}
const urls =
  body?.output?.choices?.map((c) => c?.message?.content?.[0]?.image).filter(Boolean) ?? [];
if (urls.length === 0) {
  console.error("no image in response:", JSON.stringify(body).slice(0, 800));
  process.exit(1);
}
await mkdir("../raw", { recursive: true });
for (const [i, url] of urls.entries()) {
  const img = await (await fetch(url)).arrayBuffer();
  const out = `../raw/${name}-${i + 1}.png`;
  await writeFile(new URL(out, import.meta.url), Buffer.from(img));
  console.log("saved", out);
}
console.log("request_id:", body.request_id);
