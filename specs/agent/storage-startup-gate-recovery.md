# Agent 存储启动守门器终态失败后的进程回收

## 背景

Host（desktop utility process）为每个 workspace spawn Agent CLI，并为该 stdio 连接创建
`ZCodeProtocolClient`。当命令声明 `supportsStorageStartup` 时，client 内建的
`ZCodeStorageStartupGate` 在创建即武装 30 秒首帧定时器：CLI 必须在该窗口内发出第一帧
`startup/storageState`（正常启动时 CLI 在打开 SQLite 前就会发出 `checking`）。

守门器一旦以 `startup_status_timeout` 进入终态失败：

- `accept()` 对后续所有帧返回 false（即使 CLI 唤醒后补发 `ready` 也被丢弃）；
- `wait()` 立即抛错，client 上所有请求快速失败；
- `isWaiting` 恒为 true，空闲回收把终态失败误判为「迁移进行中」而跳过；
- CLI 进程本身可能存活，`getClient` 无条件复用该 client。

四条路径同时失效 ⇒ 该 workspace 永久不可恢复，只有重启 App 才能解开。

## 实测根因（2026-10-14 dev 日志）

1. 21:31:39 Host 为 worktree `…/uem-controller-4a74/3531638a` spawn 新 CLI，守门器武装；
2. 用户随即合盖，CLI 尚未完成 Node 启动即被冻结，未发出任何启动帧；
3. 系统睡眠期间 darwin 定时器按绝对时间流逝，30 秒预算在睡眠中耗尽；
4. 21:47:12 唤醒，过期定时器立即触发，守门器进入 `startup_status_timeout` 终态，
   在飞的 930 秒级 RPC 全部拒绝；CLI 随后实际健康，但帧被拒收；
5. 此后 2.5 小时无任何回收/重启路径生效，用户打开会话即报
   `SQLite startup failed: startup_status_timeout`。

## 规则

- 守门器是 client 内部状态，**进程淘汰的唯一 owner 仍是 process manager**（与
  request-timeout watchdog 同一职责边界）：守门器到达终态 `failed` 且
  `errorCode !== "transport_closed"` 时，manager 立即淘汰该 managed 进程——
  从 `processesByWorkspaceKey` 移除、上报 runtime unavailable、按
  `storage-startup-failed` 原因幂等回收整棵进程树。
- `transport_closed` 失败交由既有 `client.onClose` 清理路径负责，不重复回收，
  保留「启动期进程退出」的 crash-suspect 监控语义不被改写。
- 淘汰后下一次 `getClient` 正常重新 spawn，新 client 的守门器重新武装；
  读路径（`getExistingClient`/dormant）与渲染层 60 秒重试环自动收敛，无需新增重试器。
- 守门器首帧超时阈值（默认 30 秒）通过 manager options 暴露
  `storageStartupFirstStatusTimeoutMs`，仅测试注入用，生产不覆写。

## 事件顺序

```
CLI spawn ──► gate 武装(30s)
                │
                │ 系统睡眠：定时器按绝对时间流逝
                ▼
        timer 触发 fail(startup_status_timeout)   ← 终态
                │ changed.fire
                ▼
   manager publishStorage: phase=failed
                │（errorCode ≠ transport_closed）
                ├─ processesByWorkspaceKey.delete
                ├─ reportRuntimeUnavailable
                └─ cleanupManagedProcessWithRetry("storage-startup-failed")
                           │
CLI（可能仍存活）整树回收 ◄─┘
下一次 getClient ──► 重新 spawn ──► 新 gate ──► ready ──► 恢复
```

## 验收场景

1. **唤醒复活**：spawn 后不发启动帧且进程存活 → 守门器超时终态 → managed 进程被回收、
   `listManagedProcesses` 清空、再 `getClient` 返回新 client；新 CLI 发帧后 ready，
   请求恢复成功。
2. **真实存储失败不受影响**：CLI 发出 `failed` 帧后退出 → 既有 onClose 清理照常；
   监控 `terminationKind` 不因本规则把 crash 改写为 expected 之外的新语义。
3. **transport_closed 不走新路径**：启动期进程直接退出（无帧）→ 仅 onClose 清理，
   回收原因保持 `protocol-close`。
4. **迁移期间不被误回收**：CLI 持续发 `migrating` 帧（非终态）→ 不触发本路径
   （既有「迁移不空闲回收」测试继续通过）。
