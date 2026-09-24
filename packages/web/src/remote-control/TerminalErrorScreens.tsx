import { StatusCard, isZh } from "./RemoteControlStatus.js";

/** 页面版本低于 relay 要求（spec §22）：提示刷新（Pages 常新，刷新即升级）。 */
export function PageOutdatedScreen() {
  return (
    <StatusCard
      tone="danger"
      title={isZh() ? "远控服务已更新" : "Remote service updated"}
      description={
        isZh()
          ? "当前页面版本过旧，不再被远程服务支持。请刷新页面获取新版本后重新连接。"
          : "This page version is no longer supported by the remote service. Refresh to get the latest version, then reconnect."
      }
      action={
        <button
          type="button"
          data-testid="remote-control-page-refresh"
          className="w-full rounded-lg bg-primary px-3 py-2.5 text-ui-sm font-medium text-primary-foreground"
          onClick={() => window.location.reload()}
        >
          {isZh() ? "刷新页面" : "Refresh page"}
        </button>
      }
    />
  );
}

/** 连接失败终态（spec §21.9）：中继连续失败达上限，停止自动重试。 */
export function ConnectionFailedScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <StatusCard
      tone="danger"
      title={isZh() ? "连接失败" : "Connection failed"}
      description={
        isZh()
          ? "多次尝试均无法建立连接，已停止自动重试。请检查网络后重试。"
          : "Couldn't connect after several attempts. Auto-retry stopped. Check your network and retry."
      }
      action={
        <button
          type="button"
          data-testid="remote-control-failed-retry"
          className="w-full rounded-lg bg-primary px-3 py-2.5 text-ui-sm font-medium text-primary-foreground"
          onClick={onRetry}
        >
          {isZh() ? "重试" : "Retry"}
        </button>
      }
    />
  );
}
