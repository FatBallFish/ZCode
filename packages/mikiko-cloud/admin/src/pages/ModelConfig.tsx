import { useCallback, useEffect, useState } from "react";
import { api, formatTime } from "../lib/api.tsx";

interface BuiltinResponse {
  schemaVersion: number;
  revision: number;
  config: unknown;
}

interface ModelConfigRulesShape {
  modelConfigRules?: {
    modelRules?: unknown;
    modelApiRules?: unknown;
    providerSiteRules?: unknown;
    templateModelRules?: unknown;
    builtinProviderModelRules?: unknown;
  };
  providerConfigRules?: {
    templateRules?: unknown;
    providerRules?: unknown;
  };
}

/**
 * 模型预设配置（方案 D.3 v1）：JSON 模式为全保真逃生通道（与旧后台一致），
 * 发布/历史/恢复沿用 worker 端 revision 语义；分区导航列出配置树的一级键。
 */
const SECTION_LABELS: Record<string, string> = {
  modelRules: "模型规则（modelRules）",
  modelApiRules: "模型 API 规则（modelApiRules）",
  providerSiteRules: "供应商站点规则（providerSiteRules）",
  templateModelRules: "模板模型规则（templateModelRules）",
  builtinProviderModelRules: "内置供应商模型规则（builtinProviderModelRules）",
};

export function ModelConfigPage() {
  const [current, setCurrent] = useState<BuiltinResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<Array<{ revision: number; updatedAt: number }>>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await api.getBuiltinConfig();
      setCurrent(response);
      setDraft(JSON.stringify(response.config, null, 2));
      setHistory(await api.builtinHistory().catch(() => []));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const publish = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const parsed = JSON.parse(draft) as unknown;
      const result = await api.putBuiltinConfig(parsed);
      setMessage(`已发布 revision ${result.revision}`);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (revision: number) => {
    if (!window.confirm(`恢复到 revision ${revision}？当前草稿将被替换。`)) return;
    setBusy(true);
    try {
      await api.restoreBuiltinConfig(revision);
      setMessage(`已恢复 revision ${revision}`);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const sections = current
    ? Object.entries(SECTION_LABELS).map(([key, label]) => {
        const rules = (current.config as ModelConfigRulesShape)?.modelConfigRules as
          | Record<string, unknown[]>
          | undefined;
        const count = Array.isArray(rules?.[key]) ? rules[key].length : 0;
        return { key, label, count };
      })
    : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-full bg-neutral-800 px-3 py-1 text-xs text-neutral-300">
          当前 revision：{current?.revision ?? "…"}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void publish()}
          className="rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-semibold text-neutral-950 disabled:opacity-40"
        >
          发布新版本
        </button>
        {message && <span className="text-xs text-emerald-400">{message}</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>

      <div className="grid grid-cols-[1fr_16rem] gap-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-500">JSON 模式（全量编辑；发布前会做结构与大小校验）</span>
            <button
              type="button"
              onClick={() => setDraft(JSON.stringify(current?.config ?? {}, null, 2))}
              className="text-xs text-neutral-500 hover:text-neutral-300"
            >
              重置为当前版本
            </button>
          </div>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="h-[32rem] w-full rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 font-mono text-xs leading-relaxed outline-none focus:border-amber-500"
          />
        </div>
        <div className="space-y-4">
          <div className="rounded-xl border border-neutral-800 p-3">
            <h3 className="mb-2 text-xs font-medium text-neutral-400">配置分区概览</h3>
            <ul className="space-y-1 text-xs text-neutral-400">
              {sections.map((section) => (
                <li key={section.key} className="flex justify-between">
                  <span className="truncate">{section.label}</span>
                  <span className="text-neutral-600">{section.count}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-neutral-800 p-3">
            <h3 className="mb-2 text-xs font-medium text-neutral-400">发布历史</h3>
            <ul className="max-h-72 space-y-1 overflow-y-auto text-xs">
              {history.map((item) => (
                <li key={item.revision} className="flex items-center justify-between gap-2">
                  <span className="text-neutral-400">
                    r{item.revision}
                    <span className="ml-1 text-[10px] text-neutral-600">{formatTime(item.updatedAt)}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void restore(item.revision)}
                    className="text-neutral-500 hover:text-amber-300"
                  >
                    恢复
                  </button>
                </li>
              ))}
              {history.length === 0 && <li className="text-neutral-600">暂无历史</li>}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
