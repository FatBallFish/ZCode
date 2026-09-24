# 中转服务部署 · Cloudflare 边缘模式

> 适用：手机页静态资源走 Cloudflare Pages CDN（不占服务器带宽），WS 经 Cloudflare named tunnel 回源自有服务器上的 relay。
> 服务器直连模式（自管 TLS 反代）见 [deploy-server.md](./deploy-server.md)。
> 契约来源：`specs/remote/mobile-remote-control.md` §18–§20。

## 1. 拓扑与关键结论

```
手机浏览器
 ├─ 静态资源: https://remote.example.com（Pages 自定义域，CNAME → <project>.pages.dev，橙云代理）
 └─ 数据面:   wss://ws.example.com/ws/phone（CF 边缘 → named tunnel → cloudflared → relay 127.0.0.1:8080）
桌面 App ──── wss://ws.example.com/ws/desktop（与手机同域走 CF 边缘，抗直连抖动）
```

真机验证得出的硬性结论（spec §18，勿绕路）：

1. **Worker 内泵 WS 不可用**：升级/路由等控制面正常，但 Host→手机方向的 RPC 帧无法穿过 Worker WebSocket 泵（ChannelClient 等不到 Initialize）。因此 relay 进程必须运行在自有服务器，Cloudflare 只做静态 CDN 与隧道入口；
2. **Workers/Pages Functions 不能 fetch 裸 IP 源站**（error 1003，与端口无关），回源必须走域名或 tunnel；
3. relay 监听 **8080**（cloudflared 回源本机端口任意，8080 为既有约定）；限频键读取 `x-forwarded-for`，经 CF 代理时透传真实 IP；
4. `cloudflared tunnel run --token` 模式不依赖 cert.pem，适合 systemd 常驻；但 **DNS 记录需在 dash 手动创建**（wrangler OAuth 默认无 `dns_records` 写权限，token 模式也不支持 `tunnel route dns`）。

## 2. 前置条件

- 域名已托管到 Cloudflare（NS 接入，dash 可管理 DNS）；
- 一台服务器（Node ≥ 18）部署 relay（步骤同直连模式的 §3.1–3.3）；
- 本地已 `wrangler login`（仅发布 Pages 需要；全部步骤均可改用 dash 界面完成）。

以 `example.com` 为例，最终需要三条 DNS 记录（全部**橙云代理**）：

| 名称     | 类型  | 内容                           | 用途           |
| -------- | ----- | ------------------------------ | -------------- |
| `remote` | CNAME | `<project>.pages.dev`          | Pages 自定义域 |
| `ws`     | CNAME | `<tunnel-id>.cfargotunnel.com` | tunnel 入口    |

（`<project>` 为 Pages 项目名，`<tunnel-id>` 为下一步创建的隧道 ID。）

## 3. 部署步骤

### 3.1 服务器：relay 进程

使用 Release 产物 `relay-cloudflare-deploy`（内含 `relay.cjs`、`web/` 手机页静态产物、模板与本文档）：

```bash
sudo mkdir -p /srv/mikiko-remote
sudo unzip relay-cloudflare-deploy.zip -d /srv/mikiko-remote
sudo cp /srv/mikiko-remote/relay.env.example /srv/mikiko-remote/relay.env
sudo vi /srv/mikiko-remote/relay.env
#   RELAY_SECRET=<openssl rand -base64 32>
#   RELAY_WEB_REMOTE_BASE=https://remote.example.com
#   RELAY_PUBLIC_WS_BASE=wss://ws.example.com
sudo cp /srv/mikiko-remote/mikiko-relay.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now mikiko-relay
curl http://127.0.0.1:8080/healthz   # {"ok":true}
```

### 3.2 Cloudflare：创建 named tunnel

dash 路径：**Zero Trust → Networks → Tunnels → Create a tunnel（Cloudflared）**：

1. 记下 Tunnel ID（配 DNS 用）与安装命令中的 **token**；
2. Public Hostname 添加：`ws.example.com` → Service `http://localhost:8080`；
3. 若 dash 未自动建 DNS，手动添加上表 `ws` 的 CNAME 记录；
4. 服务器上安装 cloudflared 并常驻：

```bash
sudo cp /srv/mikiko-remote/mikiko-tunnel.service /etc/systemd/system/
sudo vi /etc/systemd/system/mikiko-tunnel.service   # 替换 REPLACE_WITH_TUNNEL_TOKEN
sudo systemctl daemon-reload && sudo systemctl enable --now mikiko-tunnel
sudo journalctl -u mikiko-tunnel -n 20   # 出现 "Registered tunnel connection" 即成功
```

### 3.3 Cloudflare：发布手机页到 Pages

```bash
# 产物内自带预构建的域名无关静态页（web/）；也可自行构建：
#   pnpm --filter @zcode/web run build:remote-pages   → packages/web/dist-pages/
cd /srv/mikiko-remote   # 或解包产物目录
chmod +x deploy-pages.sh
PROJECT=<project> ./deploy-pages.sh web
```

然后绑定自定义域：dash **Workers & Pages → <project> → Custom domains → Set up → `remote.example.com`**（自动校验/创建 CNAME；wrangler OAuth 实测具备该权限）。

### 3.4 桌面 App 配置

与服务器直连模式相同（spec §17），只是地址换成 tunnel 域名：

```bash
cat > ~/.mikiko/remote-control.json <<'EOF'
{
  "relayWsUrl": "wss://ws.example.com/ws/desktop",
  "relayHttpUrl": "https://ws.example.com",
  "stunUrls": ["stun:stun.l.google.com:19302"],
  "deviceName": "我的 MacBook Pro"
}
EOF
```

## 4. 验证清单

```bash
curl https://ws.example.com/healthz      # 经 CF 边缘 + tunnel 回源：{"ok":true}
curl -I https://remote.example.com/      # Pages：200
```

1. 桌面出码 → 手机扫码 → 落地页秒开（静态走 CDN）→ 会话互通；
2. 手机 5s 闪断（如飞行模式切换）→ 页内自动重连恢复（grace 5min 内 token 复用）；
3. `sudo systemctl restart mikiko-relay` → 桌面自动重注册出新码，旧手机提示重扫。

## 5. 域名迁移（免重新构建）

静态产物域名无关，relay 域名只存在于两处运行时配置：

1. relay 侧：`relay.env` 的 `RELAY_PUBLIC_WS_BASE`（随票据 URL 以 `ws` 参数下发给手机，spec §5.3）与 `RELAY_WEB_REMOTE_BASE`（二维码落地页）；
2. 桌面侧：`~/.mikiko/remote-control.json`。

因此迁移 `ws.example.com → ws2.example.com` 只需：新隧道/新 CNAME → 改 `relay.env` 两个值 → `systemctl restart mikiko-relay` → 更新各桌面配置文件。**手机页无需重新构建或重新部署**；旧域名在 DNS 收敛期内仍可用（bind 成功后手机会切换到票据下发的最新 WS 基址）。

## 6. 运维与限制

| 事项           | 说明                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 带宽           | 静态资源 100% 走 Pages CDN；WS 帧经 CF 边缘转发，不占服务器公网入站端口（cloudflared 为出站长连）                                                                   |
| 限频           | bind/WS 升级按 `x-forwarded-for` 真实 IP 限频（经 CF 代理时生效）                                                                                                   |
| 故障切换       | cloudflared 与 relay 均断线自动重连；CF 故障时整链路不可用。应急路径：防火墙临时放行 8080，桌面配置改 `ws://<服务器IP>:8080/ws/desktop`（明文，仅应急），恢复后改回 |
| 单点           | relay 仍单机单进程（spec §14）；横向扩展为 v3+ 议题                                                                                                                 |
| trycloudflared | 快速隧道（`cloudflared tunnel --url`）域名随机且重启即变，仅适合临时验证，生产必须 named tunnel                                                                     |
