import type { PetSessionBubblePayload, PetSessionSummary } from "@zcode/shared";

/**
 * 宠物会话气泡页面（vanilla，无 React）：渲染 main 推送的会话摘要行；
 * 点击行 → preload.openTask → main 聚焦主窗口并切换到对应会话。
 * header：折叠/展开（多会话时收纳）+ 清空终态行；终态行 hover 出现关闭按钮。
 */

interface DesktopPetBubbleBridge {
  onSummaries(callback: (payload: PetSessionBubblePayload) => void): () => void;
  openTask(summary: PetSessionSummary): void;
  dismissTask(summary: PetSessionSummary): void;
  clearTerminal(): void;
  setCollapsed(collapsed: boolean): void;
}

declare global {
  interface Window {
    desktopPetBubble?: DesktopPetBubbleBridge;
  }
}

const ICONS: Record<PetSessionSummary["liveStatus"], string> = {
  // 进行中：旋转圆环（配合 .spin 的 CSS 动画形成 loading 效果）。
  running:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#a1a1aa" stroke-width="2.5" stroke-dasharray="42 14" stroke-linecap="round"/></svg>',
  // 需要处理：感叹号气泡。
  waiting:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3a9 9 0 0 1 9 9 9 9 0 0 1-9 9 9 9 0 0 1-9-9 9 9 0 0 1 9-9Z" fill="#f59e0b" fill-opacity="0.18" stroke="#f59e0b" stroke-width="1.6"/><path d="M12 7.5v6" stroke="#f59e0b" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.8" r="1.15" fill="#f59e0b"/></svg>',
  // 完成：对勾。
  completed:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#22c55e" stroke-width="1.8"/><path d="m8 12.4 2.7 2.7L16.2 9.6" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // 失败：叉。
  error:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#ef4444" stroke-width="1.8"/><path d="m9 9 6 6M15 9l-6 6" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/></svg>',
};

const CHEVRON_DOWN =
  '<svg viewBox="0 0 24 24" fill="none"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEVRON_UP =
  '<svg viewBox="0 0 24 24" fill="none"><path d="m18 15-6-6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CLEAR_ICON =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

function isTerminal(summary: PetSessionSummary): boolean {
  return summary.liveStatus === "completed" || summary.liveStatus === "error";
}

function rowTitle(summary: PetSessionSummary): string {
  if (summary.pendingKind === "permission") {
    return summary.pendingToolName ? `等待授权 · ${summary.pendingToolName}` : "等待授权";
  }
  if (summary.pendingKind === "userInput") return "等待输入";
  return summary.title;
}

let lastPayload: PetSessionBubblePayload | null = null;
let collapsed = false;

function renderCard(card: HTMLElement): void {
  const payload = lastPayload;
  if (!payload) return;
  const children: HTMLElement[] = [];

  // header：标签 + 清空终态按钮 + 折叠/展开按钮。
  const header = document.createElement("div");
  header.className = "header";
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = payload.rows.length > 1 ? `${payload.rows.length} 个会话` : "会话";
  header.appendChild(label);
  const clearBtn = document.createElement("button");
  clearBtn.className = "header-btn";
  clearBtn.title = "清空已完成的会话";
  clearBtn.innerHTML = CLEAR_ICON;
  if (!payload.rows.some(isTerminal)) clearBtn.disabled = true;
  clearBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    window.desktopPetBubble?.clearTerminal();
  });
  header.appendChild(clearBtn);
  const collapseBtn = document.createElement("button");
  collapseBtn.className = "header-btn";
  collapseBtn.title = collapsed ? "展开会话" : "折叠会话";
  collapseBtn.innerHTML = collapsed ? CHEVRON_UP : CHEVRON_DOWN;
  collapseBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    collapsed = !collapsed;
    // 通知 main 联动窗口高度（折叠只留 header 行）。
    window.desktopPetBubble?.setCollapsed(collapsed);
    renderCard(card);
  });
  header.appendChild(collapseBtn);
  children.push(header);

  if (!collapsed) {
    for (const summary of payload.rows) children.push(renderRow(summary));
    if (payload.overflowCount > 0) {
      const overflow = document.createElement("div");
      overflow.className = "overflow";
      overflow.textContent = `…还有 ${payload.overflowCount} 个会话`;
      children.push(overflow);
    }
  }
  card.replaceChildren(...children);
}

function renderRow(summary: PetSessionSummary): HTMLElement {
  const row = document.createElement("div");
  row.className = "row";
  const icon = document.createElement("div");
  // running 行的 icon 加旋转动画：静态缺角圆环没有"进行中"的动感。
  icon.className = `icon${summary.liveStatus === "running" ? " spin" : ""}`;
  icon.innerHTML = ICONS[summary.liveStatus];
  const meta = document.createElement("div");
  meta.className = "meta";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = rowTitle(summary);
  meta.appendChild(title);
  const previewText =
    summary.liveStatus === "running" || summary.liveStatus === "waiting"
      ? summary.lastPreview
      : undefined;
  if (previewText) {
    const preview = document.createElement("div");
    preview.className = "preview";
    preview.textContent = previewText;
    meta.appendChild(preview);
  }
  row.append(icon, meta);
  if (summary.unread && isTerminal(summary)) {
    const dot = document.createElement("div");
    dot.className = "dot";
    row.appendChild(dot);
  }
  // 终态行：hover 出现关闭按钮（仅本次运行内隐藏；会话重新运行时自动恢复展示）。
  if (isTerminal(summary)) {
    const close = document.createElement("button");
    close.className = "row-close";
    close.title = "关闭此会话";
    close.innerHTML = CLOSE_ICON;
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      window.desktopPetBubble?.dismissTask(summary);
    });
    row.appendChild(close);
  }
  // 单击/双击都触发跳转（双击语义按用户期望显式支持；重复触发幂等——
  // 第二次点击时窗口已在切换中，renderer 侧重复 setActiveTaskId 无副作用）。
  row.addEventListener("click", () => window.desktopPetBubble?.openTask(summary));
  row.addEventListener("dblclick", () => window.desktopPetBubble?.openTask(summary));
  return row;
}

function main() {
  const bridge = window.desktopPetBubble;
  const card = document.getElementById("card");
  if (!bridge || !card) return;
  bridge.onSummaries((payload) => {
    // 主题跟随 App：载荷携带 main 解析后的 dark/light，切 body data-theme 驱动 CSS。
    document.body.dataset.theme = payload.theme === "light" ? "light" : "dark";
    lastPayload = payload;
    renderCard(card);
  });
}

main();
