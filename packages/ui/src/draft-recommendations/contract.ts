/** 推荐只提供本地呈现数据；填入草稿不自动发送、不请求上游 CDN。 */
export { featureSuggestedPrompts, getRecommendedPromptPool } from "./featureSuggestedPrompts.js";
export { officeSuggestedPrompts, defaultSuggestedPrompts } from "./officeSuggestedPrompts.js";
export type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

export {
  subscribeRecommendedPrompts,
  getRecommendedPromptsRevision,
  registerRecommendedPromptPane,
  unregisterRecommendedPromptPane,
  advanceRecommendedPromptPane,
  getRecommendedPromptsForPane,
} from "./featureSuggestedPromptRotation.js";
