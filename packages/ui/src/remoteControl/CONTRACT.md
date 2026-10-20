# 自建远控 UI

Main remoteControlService 是配对/连接/票据的唯一 owner；hook 只订阅只读镜像并发平台命令。Renderer 的 pending 只用于按钮防重，不成为连接事实。

自建 Mikiko ID、扫码/设备直连/P2P 路径继续沿原协议；这里不装配上游 Relay V2。BotChannel 配置复用现有 BotsDialog 的公开入口。
