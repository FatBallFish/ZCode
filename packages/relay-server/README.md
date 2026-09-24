# 手机远控 Relay

契约来源：`specs/remote/mobile-remote-control.md`。自研中转服务：设备注册、HMAC 票据签发校验、单设备踢人、连接路由与帧转发；全内存、零业务状态、不解析 RPC 帧。

## 部署

relay 进程本体在两种模式下完全相同（均为零依赖单文件 `relay.cjs`，Node ≥ 18），区别只在入口层：

| 模式            | 手机页静态资源         | WS/API 入口                           | 文档                                                     |
| --------------- | ---------------------- | ------------------------------------- | -------------------------------------------------------- |
| 服务器直连      | 自有服务器（反代托管） | `wss://<服务器域名>`（反代终止 TLS）  | [docs/deploy-server.md](./docs/deploy-server.md)         |
| Cloudflare 边缘 | Cloudflare Pages CDN   | named tunnel（CF 边缘 → cloudflared） | [docs/deploy-cloudflare.md](./docs/deploy-cloudflare.md) |

部署模板（systemd 单元、env 示例、Caddyfile、Pages 发布脚本）在 [deploy/](./deploy/)；Release 流水线随桌面安装包发布两种部署产物（spec §20）。

> Worker 内泵 WS 的方案不可行（控制面正常、RPC 数据面不通），结论与证据见 spec §18。

## 本地开发与测试

```bash
pnpm install
pnpm dev    # 需要环境变量见 src/entry.ts 顶部注释
pnpm test   # 单测 + WS/票据/踢人/限频 + 真实 RPC 管道 E2E + P2P 升级 E2E
pnpm build:bundle   # 产出 dist/relay.cjs（部署单文件）
```

桌面 App 端点配置（环境变量 > `~/.mikiko/remote-control.json` > 关闭）与手机页构建细节见上述两份部署文档。
