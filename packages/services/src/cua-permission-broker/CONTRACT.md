# CUA 权限与本机 Helper 适配

本服务目录持有权限/安装/独立状态页启动适配。实际原生执行能力来自当前分发提供的 zcode-cua 公共合同；开源 stub 的 unavailable/fail-closed 事实不得被本模块伪装为可用。

状态页只解析 Mikiko 安装布局和当前既有 legacy 候选，存在性检查与安装动作由调用方注入。会话接纳、权限事实和窗口生命周期仍属于原 owner，不在启动助手中复制。

v1.1.4 的 Mikiko 原生后端是独立 adapter，复用既有权限 service RPC，不实现或冒充上述官方 producer。
它只在本地 macOS14+、资源有效且插件显式启用时调用本App的 doctor / idle-only restart-agent；
核对 app-agent 身份、路径和 build 后投影权限事实，不主动截屏，不维护第二份控制租约。
Main提供资源路径，原生app-agent拥有权限身份与全局lease；UI只经service读取。
