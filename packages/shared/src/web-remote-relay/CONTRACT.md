# web-remote-relay

定义 relay V2 消息、HTTP 结构与连接生命周期规则。

contract.ts 是 wire schema 与错误分类；domain 只计算退避和心跳间隔，adapters 拥有定时器。每个 transport 独占 retry/heartbeat，stop 清理两个定时器。不得记录 JWT/token，不持有 task/workspace 状态。

完整语义见 [Relay V2 spec](../../../../docs/web-remote-control/relay-v2-pairing.md)。

Mikiko 产品链路继续使用自建 relay；本模块额外纳入既有公开 `web-remote-control-heartbeat.ts` 纯心跳/抖动计算入口。该入口没有 V2 token/SID 依赖、不创建计时器或 transport，不代表 V2 装配。legacy 自建 transport 继续持有其单一心跳生命周期。
