import { useCallback, useEffect, useState } from "react";
import type { ChatGPTAccountView } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/**
 * ChatGPT OAuth 账号列表（脱敏视图）+ 变更订阅。
 * 事实 owner 是 host ChatGPTAccountService；本 hook 只做读投影。
 * 旧 host 进程无该服务（可选注入）时降级为空列表，不阻断 UI。
 */
export function useChatGPTAccounts(): {
  accounts: ChatGPTAccountView[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const services = useServices();
  const service = services.chatgptAccountService;
  const [accounts, setAccounts] = useState<ChatGPTAccountView[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!service) {
      setLoading(false);
      return;
    }
    try {
      setAccounts(await service.getAccounts());
    } catch (error) {
      logger.warn("chatgpt accounts load failed", { error });
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    void refresh();
    if (!service) return;
    const dispose = service.onDidChangeAccounts((next: ChatGPTAccountView[]) => {
      setAccounts(next);
    });
    return () => dispose.dispose();
  }, [refresh, service]);

  return { accounts, loading, refresh };
}

/** 模型选择器分组标签：account:chatgpt:{accountId} → 名称（无则邮箱）。 */
export function buildChatGPTAccountLabels(
  accounts: readonly ChatGPTAccountView[],
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const account of accounts) {
    labels[`account:chatgpt:${account.accountId}`] =
      account.displayName?.trim() || account.email || account.accountId;
  }
  return labels;
}
