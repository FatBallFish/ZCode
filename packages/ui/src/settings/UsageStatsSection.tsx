import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";
import { Sub2ApiUsagePanel } from "@/settings/usage-stats/Sub2ApiUsagePanel.js";
import { ChatGPTUsagePanel } from "@/settings/usage-stats/ChatGPTUsagePanel.js";
import {
  CodingPlanUsagePanel,
  type CodingPlanUsageSource,
} from "@/settings/usage-stats/CodingPlanUsagePanel.js";

export type UsageStatsSectionTab =
  | "app"
  | "sub2api"
  | "chatgpt"
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

  if (activeTab === "sub2api") {
    return <Sub2ApiUsagePanel />;
  }

  if (activeTab === "chatgpt") {
    return <ChatGPTUsagePanel />;
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
