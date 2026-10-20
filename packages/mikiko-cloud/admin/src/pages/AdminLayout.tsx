import { useState } from "react";
import { useSession } from "../lib/api.tsx";
import { TicketsPage } from "./Tickets.tsx";
import { FeatureConfigPage } from "./FeatureConfig.tsx";
import { ModelConfigPage } from "./ModelConfig.tsx";

type Section = "tickets" | "requirements" | "model" | "feature-config";

const NAV: Array<{ key: Section; label: string }> = [
  { key: "tickets", label: "问题反馈工单" },
  { key: "requirements", label: "产品需求" },
  { key: "model", label: "模型预设配置" },
  { key: "feature-config", label: "功能配置" },
];

/** 后台骨架：左侧固定菜单 + 右侧内容区（方案 D.3，替代旧版单页纵向堆叠）。 */
export function AdminLayout() {
  const { signOut } = useSession();
  const [section, setSection] = useState<Section>("tickets");
  const current = NAV.find((item) => item.key === section)!;

  return (
    <div className="flex h-dvh bg-neutral-950 text-neutral-200">
      <aside className="flex w-56 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900/60">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-amber-600 text-base font-black text-neutral-950">
            M
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Mikiko 云</div>
            <div className="text-[10px] text-neutral-500">管理后台</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setSection(item.key)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                item.key === section
                  ? "bg-amber-500/15 font-medium text-amber-300"
                  : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mx-3 mb-4 rounded-lg px-3 py-2 text-left text-sm text-neutral-500 transition hover:bg-neutral-800/60 hover:text-neutral-300"
        >
          退出登录
        </button>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-10 border-b border-neutral-800/80 bg-neutral-950/80 px-8 py-4 text-base font-semibold backdrop-blur">
          {current.label}
        </header>
        <div className="p-8">
          {section === "tickets" && <TicketsPage kind="bug" />}
          {section === "requirements" && <TicketsPage kind="feature" />}
          {section === "model" && <ModelConfigPage />}
          {section === "feature-config" && <FeatureConfigPage />}
        </div>
      </main>
    </div>
  );
}
