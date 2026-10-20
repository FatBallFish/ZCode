import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  formatTime,
} from "../lib/api.tsx";

/**
 * 模型预设配置（方案 D.3）：表单编辑器（modelRules / modelApiRules / providerSiteRules
 * 三分区可视化卡片）+ JSON 模式 + 发布/历史/恢复。
 * 表单能力对齐旧 admin.html 的 renderForm/renderRuleCard：编辑常用字段后以 JSON 模式
 * 为全保真逃生通道（templateRules 等未覆盖分区维持 JSON 模式不变）。
 */

interface BuiltinResponse {
  schemaVersion: number;
  revision: number;
  config: unknown;
}

interface ModelConfigRules {
  modelRules?: Array<Record<string, unknown>>;
  modelApiRules?: Array<Record<string, unknown>>;
  providerSiteRules?: Array<Record<string, unknown>>;
  templateModelRules?: Array<Record<string, unknown>>;
  builtinProviderModelRules?: Array<Record<string, unknown>>;
}

interface RuleSection {
  key: keyof Pick<ModelConfigRules, "modelRules" | "modelApiRules" | "providerSiteRules">;
  label: string;
  description: string;
  /** 卡片上可编辑的字段（按 commonality 挑选）。 */
  editableFields: Array<{ key: string; label: string; type: "text" | "select"; options?: string[] }>;
}

const SECTIONS: RuleSection[] = [
  {
    key: "modelRules",
    label: "模型规则（modelRules）",
    description: "按模型匹配的属性覆盖（contextWindow / inputFormat / reasoning 等）",
    editableFields: [
      { key: "modelMatch", label: "模型匹配", type: "text" },
    ],
  },
  {
    key: "modelApiRules",
    label: "模型 API 规则（modelApiRules）",
    description: "按模型 + API 格式匹配的属性覆盖",
    editableFields: [
      { key: "modelMatch", label: "模型匹配", type: "text" },
      { key: "apiTypeMatch", label: "API 格式匹配", type: "text" },
    ],
  },
  {
    key: "providerSiteRules",
    label: "供应商站点规则（providerSiteRules）",
    description: "按模型 + API 格式 + 站点 URL 匹配的属性覆盖",
    editableFields: [
      { key: "modelMatch", label: "模型匹配", type: "text" },
      { key: "apiTypeMatch", label: "API 格式匹配", type: "text" },
      { key: "baseUrlMatch", label: "站点 URL 匹配", type: "text" },
    ],
  },
];

const JSON_SECTIONS: Array<{ key: string; label: string }> = [
  { key: "templateModelRules", label: "模板模型规则" },
  { key: "builtinProviderModelRules", label: "内置供应商模型规则" },
];

type Tab = "form" | "json";

export function ModelConfigPage() {
  const [current, setCurrent] = useState<BuiltinResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<Array<{ revision: number; updatedAt?: number }>>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("form");

  const rules = useMemo(
    () => (current?.config as { modelConfigRules?: ModelConfigRules })?.modelConfigRules ?? {},
    [current],
  );

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

  const syncDraftFromRules = useCallback((nextRules: ModelConfigRules) => {
    const config = JSON.parse(draft || "{}") as Record<string, unknown>;
    config.modelConfigRules = nextRules;
    setDraft(JSON.stringify(config, null, 2));
  }, [draft]);

  const updateRule = useCallback(
    (sectionKey: string, index: number, field: string, value: string) => {
      const nextRules = { ...rules } as Record<string, Array<Record<string, unknown>>>;
      const section = [...(nextRules[sectionKey] ?? [])];
      const rule = { ...section[index] };
      if (field === "__config__") {
        // config 子对象的 JSON 编辑：整体替换。
        try {
          rule.config = JSON.parse(value) as unknown;
        } catch {
          return;
        }
      } else {
        if (rule[field] === undefined && value === "") return;
        rule[field] = value === "" ? undefined : value;
        if (rule[field] === undefined) delete rule[field];
      }
      section[index] = rule;
      nextRules[sectionKey] = section;
      syncDraftFromRules(nextRules as ModelConfigRules);
    },
    [rules, syncDraftFromRules],
  );

  const removeRule = useCallback(
    (sectionKey: string, index: number) => {
      const nextRules = { ...rules } as Record<string, Array<Record<string, unknown>>>;
      const section = [...(nextRules[sectionKey] ?? [])];
      section.splice(index, 1);
      nextRules[sectionKey] = section;
      syncDraftFromRules(nextRules as ModelConfigRules);
    },
    [rules, syncDraftFromRules],
  );

  const addRule = useCallback(
    (sectionKey: string) => {
      const nextRules = { ...rules } as Record<string, Array<Record<string, unknown>>>;
      const section = [...(nextRules[sectionKey] ?? [])];
      section.push({});
      nextRules[sectionKey] = section;
      syncDraftFromRules(nextRules as ModelConfigRules);
    },
    [rules, syncDraftFromRules],
  );

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

  const totalSections = useMemo(() => {
    const entries: Array<{ key: string; label: string; count: number }> = [];
    for (const section of SECTIONS) {
      entries.push({ key: section.key, label: section.label, count: (rules[section.key] ?? []).length });
    }
    for (const section of JSON_SECTIONS) {
      entries.push({
        key: section.key,
        label: section.label,
        count: ((rules as Record<string, unknown[]>)[section.key] ?? []).length,
      });
    }
    return entries;
  }, [rules]);

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

      {/* 模式切换 */}
      <div className="flex gap-1 rounded-lg border border-neutral-800 bg-neutral-900/40 p-1">
        {(["form", "json"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setTab(mode)}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition ${
              mode === tab ? "bg-amber-500/15 text-amber-300" : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {mode === "form" ? "表单编辑" : "JSON 全量编辑"}
          </button>
        ))}
      </div>

      {tab === "form" ? (
        <div className="space-y-6">
          {SECTIONS.map((section) => {
            const sectionRules = (rules[section.key] ?? []) as Array<Record<string, unknown>>;
            return (
              <section key={section.key} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-neutral-300">{section.label}</h3>
                    <p className="text-xs text-neutral-600">{section.description}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => addRule(section.key)}
                    className="rounded border border-neutral-700 px-2 py-1 text-xs hover:border-amber-500 hover:text-amber-300"
                  >
                    + 添加规则
                  </button>
                </div>
                <div className="space-y-2">
                  {sectionRules.map((rule, index) => (
                    <RuleCard
                      key={`${section.key}-${index}`}
                      section={section}
                      rule={rule}
                      onUpdate={(field, value) => updateRule(section.key, index, field, value)}
                      onRemove={() => removeRule(section.key, index)}
                    />
                  ))}
                  {sectionRules.length === 0 && (
                    <p className="rounded-lg border border-dashed border-neutral-800 px-4 py-4 text-center text-xs text-neutral-600">
                      暂无规则
                    </p>
                  )}
                </div>
              </section>
            );
          })}
          <section className="space-y-1">
            <h3 className="text-xs text-neutral-500">
              以下分区仅在 JSON 模式编辑：
              {JSON_SECTIONS.map((section) => ` ${section.label}（${((rules as Record<string, unknown[]>)[section.key] ?? []).length} 条）`)}
            </h3>
          </section>
        </div>
      ) : (
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
      )}

      <div className="grid grid-cols-[1fr_14rem] gap-4">
        <div />
        <div className="rounded-xl border border-neutral-800 p-3">
          <h3 className="mb-2 text-xs font-medium text-neutral-400">配置分区概览</h3>
          <ul className="space-y-1 text-xs text-neutral-400">
            {totalSections.map((section) => (
              <li key={section.key} className="flex justify-between">
                <span className="truncate">{section.label}</span>
                <span className="text-neutral-600">{section.count}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="rounded-xl border border-neutral-800 p-3">
        <h3 className="mb-2 text-xs font-medium text-neutral-400">发布历史</h3>
        <ul className="max-h-72 space-y-1 overflow-y-auto text-xs">
          {history.map((item) => (
            <li key={item.revision} className="flex items-center justify-between gap-2">
              <span className="text-neutral-400">
                r{item.revision}
                <span className="ml-1 text-[10px] text-neutral-600">{item.updatedAt ? formatTime(item.updatedAt) : ""}</span>
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
  );
}

function RuleCard({
  section,
  rule,
  onUpdate,
  onRemove,
}: {
  section: RuleSection;
  rule: Record<string, unknown>;
  onUpdate: (field: string, value: string) => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const displayKey = String(rule[section.editableFields[0]?.key] ?? rule.modelMatch ?? "…");
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40">
      <div className="flex items-center justify-between px-3 py-2">
        <button type="button" onClick={() => setExpanded(!expanded)} className="min-w-0 flex-1 truncate text-left text-xs text-neutral-300">
          <span className="mr-1 text-neutral-600">{expanded ? "▾" : "▸"}</span>
          {displayKey}
        </button>
        <button type="button" onClick={onRemove} className="ml-2 shrink-0 text-xs text-neutral-600 hover:text-red-400">
          删除
        </button>
      </div>
      {expanded && (
        <div className="space-y-2 border-t border-neutral-800/60 px-3 py-2.5">
          <div className="grid grid-cols-2 gap-2">
            {section.editableFields.map((field) => (
              <label key={field.key} className="space-y-0.5">
                <span className="text-[10px] text-neutral-600">{field.label}</span>
                <input
                  value={formatRuleValue(rule[field.key])}
                  onChange={(event) => onUpdate(field.key, event.target.value)}
                  className="h-7 w-full rounded border border-neutral-700 bg-neutral-900 px-2 font-mono text-xs"
                />
              </label>
            ))}
          </div>
          <div>
            <span className="text-[10px] text-neutral-600">config（属性覆盖，JSON 编辑）</span>
            <textarea
              value={JSON.stringify(rule.config ?? {}, null, 2)}
              onChange={(event) => {
                try {
                  const parsed = JSON.parse(event.target.value) as unknown;
                  onUpdate("__config__", JSON.stringify(parsed));
                } catch {
                  // JSON 不完整时不更新
                }
              }}
              rows={Math.min(10, Math.max(3, JSON.stringify(rule.config ?? {}, null, 2).split("\n").length))}
              spellCheck={false}
              className="w-full rounded border border-neutral-700 bg-neutral-950 p-2 font-mono text-[10px] leading-relaxed"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function formatRuleValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
