import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock fetch——admin API 层全部走 fetch。
const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

// SessionProvider 的 probe 调用走 fetch mock——首个调用返回 200 即已登录。
import { SessionProvider } from "../../lib/api.tsx";
import { LoginPage } from "../Login.tsx";
import { AdminLayout } from "../AdminLayout.tsx";
import { ModelConfigPage } from "../ModelConfig.tsx";

function renderWithProvider(ui: React.ReactElement) {
  return render(<SessionProvider>{ui}</SessionProvider>);
}

function mockJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

describe("Admin SPA 冒烟", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("LoginPage：标题渲染、空输入禁用提交", () => {
    renderWithProvider(<LoginPage />);
    expect(screen.getByText("Mikiko 云管理后台")).toBeDefined();
    const button = screen.getByRole("button", { name: /登录/ });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("AdminLayout：四个导航分区渲染且默认选中工单", async () => {
    // probe 返回 200（admin 已登录）→ AdminLayout 渲染。
    fetchMock.mockResolvedValueOnce(mockJson({ code: 0, data: { items: [], total: 0 } }));
    renderWithProvider(<AdminLayout />);
    await waitFor(() => {
      expect(screen.getAllByText("问题反馈工单")[0]).toBeDefined();
    });
    expect(screen.getByText("产品需求")).toBeDefined();
    expect(screen.getByText("模型预设配置")).toBeDefined();
    expect(screen.getByText("功能配置")).toBeDefined();
  });

  it("ModelConfigPage：加载后显示 revision 与表单/JSON 切换", async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockJson({ schemaVersion: 1, revision: 30, config: { modelConfigRules: { modelRules: [{ modelIdPattern: "^gpt-5" }] } } }),
      )
      .mockResolvedValueOnce(mockJson({ revisions: [] }));

    renderWithProvider(<ModelConfigPage />);
    await waitFor(() => {
      expect(screen.getByText(/当前 revision：30/)).toBeDefined();
    });
    expect(screen.getByText("表单编辑")).toBeDefined();
    expect(screen.getByText("JSON 全量编辑")).toBeDefined();
    expect(screen.getAllByText(/模型规则/)[0]).toBeDefined();
  });
});
