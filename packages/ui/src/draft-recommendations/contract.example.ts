import { getRecommendedPromptPool } from "./contract.js";
/** 选择推荐后由现有 Composer 草稿 owner 接收正文，示例不投递消息。 */
export function recommendationForDraft(officeMode: boolean, locale: "cn" | "en"): string | null {
  const first = getRecommendedPromptPool(officeMode)[0];
  return first?.prompt[locale] ?? null;
}
