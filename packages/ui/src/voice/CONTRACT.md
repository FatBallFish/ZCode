# 语音输入 UI

唯一 controller 拥有麦克风采集、IPC 音频帧、转写/整理和安全回填时序；Zustand 只持有呈现和共享 toggle/cancel 入口。Main VoiceService 拥有引擎与会话事实。

所有平台动作经 IPlatformService hook。取消不得发送；整理结果不能覆盖后续用户编辑。桌面挂载单例，Web 不展示未实现能力。
