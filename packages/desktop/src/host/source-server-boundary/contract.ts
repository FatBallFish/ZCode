/** 复用既有 Host owner 和错误类型；兼容入口继续指向同一个实现。 */
export {
  SourceServerConnectionManager,
  SourceServerInstallRequiredError,
  SourceServerUpgradeRequiredError,
  SourceServerIdentityChangePendingError,
} from "../sourceServerConnectionManager.js";
export type {
  ManagedSourceServerConnection,
  SourceServerConnectionInvalidatedEvent,
  SourceServerConnectionManagerOptions,
  ConnectSourceServerOptions,
  StartupReconnectResult,
  SourceServerConnectionState,
  SourceServerConnectionStateSnapshot,
} from "../sourceServerConnectionManager.js";
export { SourceServerDirectory } from "../sourceServerDirectory.js";
export type {
  SourceServerDirectoryOptions,
  SourceServerHandshakeRecord,
  SourceServerHandshakeResult,
  SourceServerDirectorySnapshot,
  SourceServerReconnectCandidate,
} from "../sourceServerDirectory.js";
