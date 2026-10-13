import type { Event } from "@zcode/rpc";
import { ServiceChannels, type ChatGPTAccountView } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * ChatGPT OAuth 账号服务（spec specs/desktop/chatgpt-oauth.md）。
 *
 * host 进程唯一事实 owner：授权流程（loopback 1455 回调）、sub2api 导入、
 * 账号信息刷新（wham/accounts/usage/credits/models）、令牌刷新、额度重置、退出。
 * 凭证仅存加密 credentials.json；renderer 通过脱敏视图消费。
 */

export interface ChatGPTAuthorizationSession {
  sessionId: string;
  authUrl: string;
}

export interface ChatGPTAuthorizationResult {
  accountId: string;
  email: string;
}

export interface ChatGPTImportedAccountResult {
  accountId: string;
  email: string;
  state: "created" | "updated";
  /** 补全失败不回滚账号，仅提示（详情页可手动刷新）。 */
  enrichError?: string;
}

export interface ChatGPTImportResult {
  imported: ChatGPTImportedAccountResult[];
  skipped: Array<{ name?: string; email?: string; reason: string }>;
}

export interface IChatGPTAccountService {
  /** 全部账号（脱敏视图，按 createdAt 升序）。 */
  getAccounts(): Promise<ChatGPTAccountView[]>;

  /**
   * 发起浏览器授权：生成 PKCE/state，绑定 127.0.0.1:1455 回调监听。
   * 端口被占用（如 Codex CLI 正在登录）立即中断并抛错。
   */
  startAuthorization(): Promise<ChatGPTAuthorizationSession>;

  /** 取消进行中的授权（关闭监听）。 */
  cancelAuthorization(): Promise<void>;

  /** 重拉订阅/额度窗口/重置次数/模型列表并写回。 */
  refreshAccountInfo(accountId: string): Promise<ChatGPTAccountView>;

  /**
   * 后台定时刷新入口：对所有非 auth-error 账号重拉 usage/credits 等（enrich 全套）。
   * usage 现有两条更新路径——CLI 请求 outcome 的被动合并与设置页手动刷新；
   * 无请求时段额度窗口会停在旧值，由 node 装配处的定时器驱动本方法补齐。
   */
  refreshAllAccountUsage(): Promise<void>;

  /** 强制刷新令牌（Permanent 失败会把账号置 auth-error）。 */
  refreshToken(accountId: string): Promise<ChatGPTAccountView>;

  /** 消耗一次额度重置并重拉 usage/credits。 */
  resetQuota(accountId: string): Promise<ChatGPTAccountView>;

  /** 退出登录：best-effort revoke + 删除本地记录 + 摘除模型。 */
  logoutAccount(accountId: string): Promise<void>;

  /** 导入 sub2api 导出文件（仅取 ChatGPT OAuth 数据，忽略 proxies/extra）。 */
  importSub2ApiAccounts(filePath: string): Promise<ChatGPTImportResult>;

  /** 账号事实变化（增删/状态/用量/模型列表）。 */
  readonly onDidChangeAccounts: Event<ChatGPTAccountView[]>;

  /** 浏览器授权完成。 */
  readonly onAuthorizationCompleted: Event<ChatGPTAuthorizationResult>;

  /** 浏览器授权失败/超时/取消（message 面向用户）。 */
  readonly onAuthorizationFailed: Event<{ message: string }>;
}

export const IChatGPTAccountService = createServiceDescriptor<IChatGPTAccountService>(
  ServiceChannels.ChatGPTAccount,
);
