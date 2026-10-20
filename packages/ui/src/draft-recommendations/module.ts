export const draftRecommendationsModule = {
  id: "draft-recommendations",
  requires: ["ui"],
  provides: ["draft-recommendations"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
