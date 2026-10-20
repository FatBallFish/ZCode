# 自建 Web 远控适配

transport 独占配对/重连/心跳与 RPC 等待，credential/设备配对仍属原自建流程。与桌面自建 transport 保持 HMAC(passHash, nonce|role|deviceSid) 合同，不采用上游 V2 SID/token/HTTP 协议。

workspace bridge 注册仅引用既有 Host attachment；dispose 先比较 services 实例，迟到旧 bridge 不能注销新连接。手机保持 web-remote-replayable，queue/snapshot/session 事实不落 relay 或该适配器。

旧 Web source 导入路径保持公开兼容入口，本轮仅登记真实边界。
