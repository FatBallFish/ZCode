# 中转服务部署 · 服务器直连模式

> 适用：relay 与手机页静态资源全部部署在自有服务器，TLS 由前置反代（Caddy/Nginx）终止。
> 另一种模式（Cloudflare 边缘：Pages 静态 + tunnel WSS）见 [deploy-cloudflare.md](./deploy-cloudflare.md)。
> 契约来源：`specs/remote/mobile-remote-control.md`。两种模式下 relay 进程本体完全相同，区别只在入口层。

## 1. 拓扑

```
手机浏览器 ── https://remote.example.com ──► 反代（TLS）──► 静态文件（手机页）
          └─ wss://relay.example.com/ws/phone ──► 反代（TLS）──► relay:8080（本包）
桌面 App ──── wss://relay.example.com/ws/desktop ──► 反代（TLS）──► relay:8080
```

特点：链路最短、无第三方依赖；静态资源与中转 WS 全部消耗服务器带宽。若希望静态资源走 CDN、WS 走 Cloudflare 边缘，请改用 Cloudflare 模式。

## 2. 前置条件

- 一台公网服务器（Linux x64/arm64 均可），Node ≥ 18；
- 两个域名（或同一域名的两条记录）指向该服务器：`relay.example.com`（WS/API）、`remote.example.com`（手机页静态）；
- 服务器防火墙只放行 80/443（relay 本体仅监听 `127.0.0.1:8080`，不对公网暴露）。

## 3. 安装（使用 Release 产物 relay-server-deploy）

产物内容：`relay.cjs`（零依赖单文件）、`web/`（手机页静态产物，域名无关）、`relay.env.example`、`mikiko-relay.service`、`Caddyfile.example`、本文档。

```bash
# 3.1 上传产物到服务器
scp relay-server-deploy.zip user@example.com:/tmp/
ssh user@example.com
sudo mkdir -p /srv/mikiko-remote && sudo unzip /tmp/relay-server-deploy.zip -d /srv/mikiko-remote

# 3.2 写环境变量（生成密钥：openssl rand -base64 32）
sudo cp /srv/mikiko-remote/relay.env.example /srv/mikiko-remote/relay.env
sudo vi /srv/mikiko-remote/relay.env   # 替换 RELAY_SECRET 与两个域名

# 3.3 systemd 常驻
sudo cp /srv/mikiko-remote/mikiko-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mikiko-relay
systemctl status mikiko-relay   # 应显示 active (running)

# 3.4 Caddy 反代（自动签发 TLS 证书；已有 Nginx 可等价配置）
sudo apt install -y caddy
sudo cp /srv/mikiko-remote/Caddyfile.example /etc/caddy/Caddyfile   # 按实际域名修改
sudo systemctl reload caddy
```

不用 Release 产物、从源码构建：仓库根目录执行
`pnpm install && pnpm --filter @zcode/relay-server run build:bundle`，产物为 `packages/relay-server/dist/relay.cjs`。

## 4. 手机页静态托管

手机页来自 `packages/web`：

```bash
pnpm --filter @zcode/web run build:remote-pages   # 产物 dist-pages/，域名无关
```

将 `dist-pages/` 全部内容上传到 `remote.example.com` 对应的静态根目录（Caddyfile 示例为 `/srv/mikiko-remote/web`）。
静态产物**不注入任何域名**：手机页通过二维码票据 URL 的 `ws` 参数在运行时定位 relay（spec §5.3），更换 relay 域名无需重新构建。

若静态页托管在 `/remote` 子路径而非独立域名，改用 `pnpm --filter @zcode/web run build:remote`（`--base=/remote/`），并把 `RELAY_WEB_REMOTE_BASE` 设为 `https://<host>/remote`。

## 5. 桌面 App 配置

桌面端与 relay 的地址由本机配置决定，**与 App 打包无关**（spec §17）：

```bash
# 方式一：配置文件（推荐，dev 与打包版 App 通用）
cat > ~/.mikiko/remote-control.json <<'EOF'
{
  "relayWsUrl": "wss://relay.example.com/ws/desktop",
  "relayHttpUrl": "https://relay.example.com",
  "stunUrls": ["stun:stun.l.google.com:19302"],
  "deviceName": "我的 MacBook Pro"
}
EOF

# 方式二：环境变量（优先级高于配置文件）
ZCODE_REMOTE_CONTROL_RELAY_WS_URL=wss://relay.example.com/ws/desktop \
ZCODE_REMOTE_CONTROL_RELAY_HTTP_URL=https://relay.example.com \
<启动 App>
```

两个端点必须成对配置，缺失任意一个则功能整体关闭、零出网。

## 6. 验证清单

```bash
curl https://relay.example.com/healthz          # {"ok":true}
curl -I https://remote.example.com/             # 200，index.html
```

1. 桌面 App 侧边栏底部出现手机图标 → 打开 → 出码；
2. 手机扫码 → 落地页显示设备名 → 会话列表与桌面一致、消息双向实时；
3. 同一二维码用第二台手机打开 → 提示票据已失效（一次性）；
4. 换一台手机重新扫码 → 旧手机立即收到「已在其他设备连接」（单设备语义）。

## 7. 运维

| 事项     | 说明                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| 日志     | `journalctl -u mikiko-relay -f`（进程内 `info` 为生命周期事件，`debug` 不落盘）                             |
| 升级     | 替换 `relay.cjs` → `systemctl restart mikiko-relay`；无状态迁移                                             |
| 重启语义 | 全内存设计：进程重启后全部会话/设备凭证丢失。桌面自动重新注册并刷新二维码，手机需重扫（spec §6.7，v1 接受） |
| 密钥轮换 | 更换 `RELAY_SECRET` 后所有存量票据/会话立即失效，等价于重启；桌面自动重注册                                 |
| 带宽     | v1 全中转模式上下行都过本机；v2 P2P 升级成功后多数流量旁路直连，仅剩信令与兜底                              |
| 端口变更 | 修改 `relay.env` 的 `RELAY_PORT` 后同步改反代 upstream；`RELAY_PUBLIC_WS_BASE` 始终是对外域名               |
