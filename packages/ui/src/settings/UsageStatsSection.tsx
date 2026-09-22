import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";
import { Sub2ApiUsagePanel } from "@/settings/usage-stats/Sub2ApiUsagePanel.js";
import {
  CodingPlanUsagePanel,
  type CodingPlanUsageSource,
} from "@/settings/usage-stats/CodingPlanUsagePanel.js";

export type UsageStatsSectionTab =
  | "app"
  | "sub2api"
  | "sub2api-plan"
  | "codingPlan"
  | `codingPlan:${string}`;

export function UsageStatsSection({
  activeTab,
  providerSourcesLoading,
  workspaceIdentity,
  workspacePath,
  selectedCodingPlanSource,
}: {
  activeTab: UsageStatsSectionTab;
  providerSourcesLoading: boolean;
  workspaceIdentity?: string;
  workspacePath?: string;
  selectedCodingPlanSource?: CodingPlanUsageSource | null;
}) {
  if (activeTab === "app") {
    return <AppUsagePanel />;
  }

  if (activeTab === "sub2api" || activeTab === "sub2api-plan") {
    return <Sub2ApiUsagePanel initialView={activeTab === "sub2api-plan" ? "plan" : "usage"} />;
  }

  return (
    <CodingPlanUsagePanel
      loadingSources={providerSourcesLoading}
      workspaceIdentity={workspaceIdentity}
      workspacePath={workspacePath}
      selectedSource={selectedCodingPlanSource}
    />
  );
}
