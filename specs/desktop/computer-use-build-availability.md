# Computer Use 构建可用性

- producer 唯一检测 owner 是 `packages/desktop/scripts/computer-use-producer.mjs`；不能仅根据操作系统或 CUA 插件目录存在推断 Helper 可用。
- Main 构建把该检测结果写入 Mikiko 命名的编译常量；不存在/占位 producer 时 GetCuaOsSupport 返回 `build-unavailable`。真实 producer 的 macOS 版本地板和其他平台既有规则保留。
- 设置页先读取本地桌面能力；缺 producer 时明确显示“此构建不包含 Computer Use / Helper”，不显示启动中、插件启用、授权、重启或反复刷新入口，不调用权限状态/授权 RPC。
- 能力读取完成前不启动权限查询。真实 producer + 支持 macOS 保留原权限操作；低版本 macOS 保留系统版本提示；远端设置继续显示远端能力边界。
- 本次不恢复闭源 producer、不修改签名、TCC 或权限策略。真实 producer 来源未提供时，不把 UI 可用性修复写成 Helper 已恢复。

```mermaid
sequenceDiagram
  participant B as tsup / producer detection
  participant M as Main capability owner
  participant U as ComputerUse settings
  participant P as Permission service
  B->>M: embedded build availability
  U->>M: GetCuaOsSupport
  alt producer missing or placeholder
    M-->>U: build-unavailable
    Note over U,P: show build explanation; no permission query/authorization
  else real producer and supported macOS
    M-->>U: supported
    U->>P: existing read-only permission query
  end
```

验收：占位/缺失 producer 的编译常量、Main 返回态与真实 UI 无授权行为均有回归；真实 producer/低 OS/非 macOS 状态用隔离输入验证，不运行个人机器权限变更。
