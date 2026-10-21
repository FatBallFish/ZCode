#!/usr/bin/env python3
"""读取 .bench-results/live-*.json，生成预设 × 模型对比 markdown。"""
import json
import sys
from pathlib import Path

RESULTS = Path(__file__).resolve().parents[1] / ".bench-results"


def fmt_pct(value):
    return f"{value * 100:.1f}%"


def main(stamp):
    files = sorted(RESULTS.glob(f"live-{stamp}*.json"))
    if not files:
        print(f"no results for {stamp}")
        sys.exit(1)
    data = json.loads(files[-1].read_text())
    results = data["results"]
    errors = data.get("errors", [])

    order_preset = ["default", "fused", "deepseek-style", "codex-style"]
    results.sort(key=lambda r: (r["target"], order_preset.index(r["preset"])))

    print(f"## 实测结果（{stamp}，{len(results)} runs，失败 {len(errors)}）\n")
    if data.get("cacheControlUnsupported"):
        print(f"> cache_control 被拒并全局降级：{data['cacheControlUnsupported']}\n")

    print("| 模型 | 预设 | 总命中率 | 压缩前 | 压缩后首turn | 压缩后聚合 | 压缩前token | 压缩后token | 压缩率 | 保留entries | 摘要输出 | 回忆探针 |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in results:
        c = r["compaction"]
        p = r["preCompactOnly"]
        print(
            f"| {r['target']}({r['model']}) | {r['preset']} "
            f"| {fmt_pct(r['totals']['hitRate'])} "
            f"| {fmt_pct(p['hitRate'])} "
            f"| {fmt_pct(r['postCompact']['firstTurnHitRate'])} "
            f"| {fmt_pct(r['postCompact']['aggregateHitRate'])} "
            f"| {c['preCompactTokens']} | {c['postCompactTokens']} "
            f"| {fmt_pct(c['reductionRatio'])} "
            f"| {c['preservedEntries']} | {c['summaryOutputTokens']} "
            f"| {fmt_pct(r['recallAccuracy'])} |"
        )
    for e in errors:
        print(f"| {e['target']} | {e['preset']} | ERROR: {e['error'][:120]} |")

    print("\n### 逐请求明细（压缩后首 3 请求）\n")
    for r in results:
        posts = [rec for rec in r["requests"] if rec["phase"] == "post"]
        detail = "; ".join(
            f"in {rec['inputTokens']}/read {rec['cacheRead']}/write {rec['cacheWrite']}"
            for rec in posts
        )
        print(f"- {r['target']}/{r['preset']}: {detail}")

    print("\n### 回忆探针明细\n")
    for r in results:
        for probe in r["recallProbes"]:
            ok = "✅" if probe["answeredPort"] == probe["expectedPort"] else "❌"
            print(
                f"- {ok} {r['target']}/{r['preset']} {probe['module']}: "
                f"expect {probe['expectedPort']} got {probe['answeredPort']} — {probe['raw'][:90]}"
            )


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "full-1")
