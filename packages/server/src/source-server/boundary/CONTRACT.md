# Source Server transport

Owner：remote-workspace。层：adapters。公开合同只转出已有 transport/probe 的工厂、接口、结果与错误；不再创建 transport owner、缓存或连接状态机。

- 一个 adapter 复用同一 RemoteTarget 的 backend；Host attachment 文件传输复用该连接。
- probe 使用一次只读 POSIX 命令读取环境、安装、版本、release identity 和 daemon 状态。Linux 已知 glibc 低于 2.28 时在安装前拒绝；无法识别版本不猜测拒绝。
- 新默认路径和命令使用 `.mikiko/server` 与 `bin/mikiko`；既有 probe marker 是内部协议，保留兼容。
- 已取消 context 必须在创建 backend/执行命令前拒绝。只操作当前 adapter/target 拥有的资源，不回收其他窗口或共享业务状态。
- 事件顺序：调用者传 target/context → adapter 取得唯一 backend → probe 读取事实 → 返回环境/安装投影或带阶段错误；安装、daemon 与 channel 调度继续归既有 adapter。
- probe 与 adapter 共用 `types.ts`，该文件不反向依赖两者；adapter 的类型 re-export 保留旧入口兼容，错误类/工厂与运行时逻辑不迁移。这样同时消除类型依赖环与运行时环。

外部模块使用 `boundary/contract.ts`；原 `transportAdapter.ts` 与 `sourceServerProbe.ts` 继续作为既有兼容入口。命令收集、下载脚本、SSH/WSL/Docker backend 仍由既有 server 模块提供。
