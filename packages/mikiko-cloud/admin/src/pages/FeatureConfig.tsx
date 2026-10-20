import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.tsx";

/** 功能配置（方案 D.3）：动态工作流灰度 + 分享限流（与旧后台两控件对齐）。 */
export function FeatureConfigPage() {
  const [configs, setConfigs] = useState<Record<string, unknown> | null>(null);
  const [dynamicWorkflowMode, setDynamicWorkflowMode] = useState("enabled");
  const [publishPerMinute, setPublishPerMinute] = useState(10);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const next = await api.getClientConfigs();
      setConfigs(next);
      const dynamicWorkflow = next.dynamicWorkflow as { mode?: string } | undefined;
      setDynamicWorkflowMode(dynamicWorkflow?.mode ?? "enabled");
      const share = next.share as { publishPerMinutePerIp?: number } | undefined;
      setPublishPerMinute(share?.publishPerMinutePerIp ?? 10);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await api.putClientConfigs({
        ...(configs ?? {}),
        dynamicWorkflow: { mode: dynamicWorkflowMode },
        share: { publishPerMinutePerIp: publishPerMinute },
      });
      setMessage("已保存");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-xl space-y-6">
      <label className="block space-y-1.5">
        <span className="text-sm text-neutral-300">动态工作流灰度</span>
        <select
          value={dynamicWorkflowMode}
          onChange={(event) => setDynamicWorkflowMode(event.target.value)}
          className="h-9 w-56 rounded-lg border border-neutral-700 bg-neutral-900 px-2 text-sm"
        >
          <option value="enabled">全量开启</option>
          <option value="disabled">全量关闭</option>
        </select>
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm text-neutral-300">分享发布限流（每分钟 / IP）</span>
        <input
          type="number"
          min={1}
          max={600}
          value={publishPerMinute}
          onChange={(event) => setPublishPerMinute(Number(event.target.value) || 1)}
          className="h-9 w-32 rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm"
        />
      </label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-semibold text-neutral-950 disabled:opacity-40"
        >
          保存
        </button>
        {message && <span className="text-xs text-emerald-400">{message}</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}
