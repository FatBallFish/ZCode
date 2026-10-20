# web-remote-control

手机远控 admission、设备列表、transport 与只读页面。

入口通过 auth/HTTP/location/storage 端口操作外部状态；契约的设备分组与缓存展示类型不依赖实现。entry 的 AbortSignal 控制本次导航；transport 的 socket/generation 控制连接。只提取帧解析与独立请求关联，不创建第二份恢复 owner。Main/Host/CLI 继续拥有业务状态，手机仍为 replayable。

bootstrap 请求只读取响应。version guard 校验当前请求代际与版本后，同步通过 `onAccepted` 提交查看 epoch 等接受副作用；失效、释放或版本不匹配的回包不得产生该副作用。

Mikiko 产品入口保留自建 `remote-control`（Mikiko ID / 设备认领 / 票据 / P2P）与原 HMAC 扫码协议。
`main.tsx` 和 Desktop manager 不装配上游 Relay V2 的 token、device HTTP 或 transport。
本模块的 lifecycle、bridge recovery、task-view、workspace bridge、版本守卫和只读页面
作为通用能力复用；V2 entry/device/token/transport 仅保留为隔离源码和独立合同测试，不能从产品
bootstrap 实例化。V2 QR DTO 留在本模块合同，不复用自建二维码 sid/hash/t 的 shared 解析器。
自建传输继续使用毫秒 client_ts 与原 10s 心跳 / 30s ACK deadline。

完整产品取舍见 [集成合同](../../../../specs/integration/upstream-v3.16.2.md)。
