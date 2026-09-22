import { cn } from "@/components/lib/utils.js";

/**
 * Mikiko 品牌标识（2026 品牌更名）。
 * 图形标：等宽直线构成的 M 字形，与 App 图标同一设计语言；currentColor 单色字形，
 * 无底色瓦片，适配任意主题背景。
 */
export function ZCodeAboutLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="64"
      height="64"
      fill="none"
      viewBox="0 0 64 64"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M17 47V17l15 16 15-16v30"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

/**
 * Mikiko 字标：六字母几何构成（等宽直线 + 正圆），纯 path、无字体依赖。
 */
export function ZCodeWordmarkLogo({ className }: { className?: string }) {
  return (
    <svg
      width="203"
      height="54"
      viewBox="-3 -3 128 34"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="square">
        <path d="M0 28V0l11 12 11-12v28" />
        <path d="M29 0v28" />
        <path d="M36 0v28M55 0 36 14l19 14" />
        <path d="M62 0v28" />
        <path d="M69 0v28M88 0 69 14l19 14" />
        <circle cx="107" cy="14" r="9.5" />
      </g>
    </svg>
  );
}
