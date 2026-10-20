import type {
  ResolveCanonicalWorkspaceKeyInput,
  SourceServerWorkspaceAliasRepo,
} from "./contract.js";

/** 完成canonical解析后再绑定attachment，不由调用者另存迁移状态。 */
export async function resolveWorkspaceBeforeAttachment(
  owner: Pick<SourceServerWorkspaceAliasRepo, "resolveCanonicalWorkspaceKey">,
  input: ResolveCanonicalWorkspaceKeyInput,
) {
  return await owner.resolveCanonicalWorkspaceKey(input);
}
