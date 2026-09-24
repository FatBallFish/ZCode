/**
 * 远程会话能力位（spec §21.5）：手机远控渲染的 Root 在挂载时标记本会话为远程只控模式。
 *
 * 只增不减（进程内一旦标记即持续到页面卸载）；用途是隐藏「依赖本地文件系统/
 * 系统文件浏览器」的入口（Finder 打开、添加项目等），这些能力在手机浏览器里必然无响应。
 * 刻意做成模块级只读位而非 React 状态：消费点散布在 memo 化的深层组件树，
 * prop 穿透会造成大范围重渲染契约变更。
 */

let remoteSession = false;

/** Root 挂载时调用（isRemoteSession prop 为 true 时）。 */
export function markRemoteSession(): void {
  remoteSession = true;
}

/** 是否处于手机远控会话（未标记即常规桌面/Web 模式）。 */
export function isRemoteSession(): boolean {
  return remoteSession;
}
