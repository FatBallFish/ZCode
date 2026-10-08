import { randomUUID } from "node:crypto";
import type { BrowserContext, Dialog, Page, ViewportSize } from "playwright-core";
import type { BrowserTabSummary } from "@zcode/contracts";

interface OwnedTab {
  id: string;
  page: Page;
}
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

export class ExternalCdpSession {
  readonly #tabs = new Map<string, OwnedTab>();
  readonly #dialogs = new Map<string, Dialog>();
  readonly #listeners = new Map<
    Page,
    { popup: (page: Page) => void; dialog: (dialog: Dialog) => void; close: () => void }
  >();
  readonly #creating = new Set<Promise<Page>>();
  #closing: Promise<void> | undefined;
  #closed = false;
  #activeTabId: string | undefined;
  constructor(readonly context: BrowserContext) {}
  get tabIds(): string[] {
    return [...this.#tabs.keys()];
  }
  get activeTabId(): string | undefined {
    return this.#activeTabId;
  }

  async createTab(): Promise<OwnedTab> {
    if (this.#closed) throw new Error("External CDP session is closed.");
    const creating = this.context.newPage();
    this.#creating.add(creating);
    let page: Page;
    try {
      page = await creating;
    } finally {
      this.#creating.delete(creating);
    }
    if (this.#closed) {
      await page.close({ runBeforeUnload: false });
      throw new Error("External CDP session closed during page creation.");
    }
    return this.registerPage(page);
  }
  async ensureTab(tabId?: string): Promise<OwnedTab> {
    if (this.#closed) throw new Error("External CDP session is closed.");
    if (tabId) {
      const tab = this.#tabs.get(tabId);
      if (!tab || tab.page.isClosed())
        throw new Error("Browser tab is unavailable to this session.");
      return tab;
    }
    const tab = this.#activeTabId ? this.#tabs.get(this.#activeTabId) : undefined;
    return tab && !tab.page.isClosed() ? tab : await this.createTab();
  }
  async activateTab(tabId: string): Promise<OwnedTab> {
    const tab = await this.ensureTab(tabId);
    this.#activeTabId = tab.id;
    await tab.page.bringToFront();
    return tab;
  }
  async closeTab(tabId?: string): Promise<void> {
    const tab = await this.ensureTab(tabId);
    await tab.page.close({ runBeforeUnload: false });
  }
  async listTabs(): Promise<BrowserTabSummary[]> {
    return await Promise.all(
      [...this.#tabs.values()]
        .filter((tab) => !tab.page.isClosed())
        .map(async (tab) => ({
          tabId: tab.id,
          url: tab.page.url(),
          title: await tab.page.title().catch(() => ""),
          viewport: tab.page.viewportSize() ?? DEFAULT_VIEWPORT,
          lifecycle: "active" as const,
          ...(tab.id === this.#activeTabId ? { active: true } : {}),
        })),
    );
  }
  dialogFor(tabId: string): Dialog | undefined {
    return this.#dialogs.get(tabId);
  }
  clearDialog(tabId: string): void {
    this.#dialogs.delete(tabId);
  }
  async setViewport(tabId: string | undefined, viewport: ViewportSize | null): Promise<void> {
    const tab = await this.ensureTab(tabId);
    await tab.page.setViewportSize(viewport ?? DEFAULT_VIEWPORT);
  }
  invalidate(): void {
    this.#closed = true;
    for (const [page, listeners] of this.#listeners) {
      page.off("popup", listeners.popup);
      page.off("dialog", listeners.dialog);
      page.off("close", listeners.close);
    }
    this.#listeners.clear();
    this.#tabs.clear();
    this.#dialogs.clear();
  }
  async close(): Promise<void> {
    if (this.#closing) return await this.#closing;
    if (this.#closed) return;
    this.#closed = true;
    this.#closing = (async () => {
      // 迟到 newPage 仍属于本任务；等待并关闭它，不能在 detach 后遗留页面。
      await Promise.allSettled(
        [...this.#creating].map(async (creating) => {
          const page = await creating;
          if (!page.isClosed()) await page.close({ runBeforeUnload: false });
        }),
      );
      // 持久 context 属于用户；只清理本 session 创建的页面，不能调用 context.close。
      const results = await Promise.allSettled(
        [...this.#tabs.values()].map(async ({ page }) => {
          if (!page.isClosed()) await page.close({ runBeforeUnload: false });
        }),
      );
      this.invalidate();
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    await this.#closing;
  }
  private registerPage(page: Page): OwnedTab {
    page.setDefaultTimeout(30_000);
    const tab = { id: `tab:${randomUUID()}`, page };
    this.#tabs.set(tab.id, tab);
    this.#activeTabId = tab.id;
    const popup = (child: Page) => {
      if (this.#closed) {
        void child.close({ runBeforeUnload: false }).catch(() => undefined);
        return;
      }
      this.registerPage(child);
    };
    const dialog = (value: Dialog) => this.#dialogs.set(tab.id, value);
    const close = () => {
      this.#tabs.delete(tab.id);
      this.#dialogs.delete(tab.id);
      this.#listeners.delete(page);
      page.off("popup", popup);
      page.off("dialog", dialog);
      if (this.#activeTabId === tab.id) this.#activeTabId = [...this.#tabs.keys()].at(-1);
    };
    this.#listeners.set(page, { popup, dialog, close });
    page.on("popup", popup);
    page.on("dialog", dialog);
    page.on("close", close);
    return tab;
  }
}
