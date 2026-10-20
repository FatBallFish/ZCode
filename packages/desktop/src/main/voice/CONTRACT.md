# 桌面语音输入 Main

VoiceService 独占模型安装/下载、引擎子进程、session 和空闲卸载；IPC 只是转发/广播，worker 只做 ASR 计算。renderer 的电平/浮层不是接纳事实。

引擎创建与 fetch 注入，测试不启动 Electron 或下载模型。麦克风未知状态 fail-closed，取消清理当前会话而不投递 Composer。现有语音 Node 测试继续覆盖完整生命周期。
