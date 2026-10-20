# desktop-web-remote-relay

将 Main 的 HTTP、存储和 device WebSocket 与 manager 装配隔离。

仅 index.ts/contract.ts 供外部消费。manager 仍唯一拥有 window runtime 与 attachment；transport 唯一拥有 socket/generation。storage 只保存非敏感身份，clearLegacy 合并并发且失败可重试。凭据从注入端口读取，HTTP 错误只返回分类。

完整语义见 [Relay V2 spec](../../../../../docs/web-remote-control/relay-v2-pairing.md)。

Mikiko 的产品装配使用同属该 Main transport 边界的公开兼容入口 `../webRemoteControlTransport.ts`、`../webRemoteControlRelayAuthProvider.ts`、`../webRemoteControlRelayAuthStorageProvider.ts`。自建 HMAC/passHash 配对、凭据存储与重连行为保持原合同；目录内 V2 适配器只保留上游源码，产品不得装配。Main 转发已有 Host attachment，不持有 session/queue/snapshot 业务事实。
