# 自建升级服务（Mikiko Update Service）

> 关联：`specs/update/update-check.md`（客户端接线与屏蔽开关）。
> 版本基线：1.0.0 起（脱离 ZCode 官方 3.x 版本序列，避免升级冲突）。

## 架构（全 Cloudflare）

```
App(electron-updater + manifestUpdateProvider)
  ├─ 清单: GET https://agent-update.mikiko.ai/api/v1/releases/electron/manifest?platform=&channel=&device_mid=
  ├─ 强更: GET https://agent-update.mikiko.ai/api/v1/client/configs
  └─ 下载: https://agent-dl.mikiko.ai/files/{version}/{asset}（Range/206、immutable 缓存）
              ↑ Cloudflare Worker(packages/update-service) ← R2(mikiko-releases) + KV(UPDATE_CONFIG)
发布: GitHub Actions(release-desktop.yml → publish-update-feed job)
        scripts/publish-update-feed.mjs → PUT /admin/*（X-Publish-Token）
        小文件单次 PUT；>90MB 自动 multipart（init/part/complete）
```

## 端点契约

| 端点                                 | 方法                            | 说明                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `/api/v1/releases/electron/manifest` | GET                             | platform∈{darwin-aarch64,darwin-x86_64,windows-x86_64,linux-x86_64}，channel∈{1:stable,3:preview}；返回 R2 `channels/{channel}/{latest*.yml}`（electron-updater UpdateInfo，URL 已重写为 agent-dl 绝对地址）；无版本 404 |
| `/api/v1/client/configs`             | GET                             | KV `client-configs`；默认 `{forceUpdate:{enabled:false,minimumVersion:"0.0.0"}}`（KV 异常 fail-open）                                                                                                                    |
| `/files/{key}`（agent-dl）           | GET/HEAD                        | R2 下载代理，单 Range 206，`immutable` 缓存                                                                                                                                                                              |
| `/admin/files/{key}`                 | PUT                             | 发布安装包/blockmap（token 鉴权）                                                                                                                                                                                        |
| `/admin/channel/{channel}/{file}`    | PUT                             | 发布通道清单                                                                                                                                                                                                             |
| `/admin/configs`                     | PUT                             | 覆写强更/灰度配置                                                                                                                                                                                                        |
| `/admin/multipart/{init              | complete}`+`/{uploadId}/{part}` | POST/PUT                                                                                                                                                                                                                 | 大文件分片（每片≤80MB，除末片≥5MB） |
| `/healthz`                           | GET                             | `{ok,version}`                                                                                                                                                                                                           |

## 已知坑（2026-09-24 实测）

1. **wrangler CLI（OAuth）的 `r2 object put`/`kv key put` 不落真实存储**（CLI 与 Worker 绑定两套视图）——一切写入必须经 `/admin/*` 端点或 Workers 绑定。
2. `uploadPart(partNumber, value)` 参数顺序（types 定义），etag 用 `R2UploadedPart.etag`。
3. wrangler.toml 顶层键（routes 等）必须放在 `[[...]]` 表段之前，否则被吞进上个表。
4. workers.dev 域名在国内被污染（error 1042/DNS 污染），必须走自定义域名。
5. Workers 免费版单请求体 ≤100MB → 安装包（144-184MB）必须 multipart。

## 客户端接线

- `packages/shared/src/zcodeEndpoint.ts`：`MIKIKO_UPDATE_ENDPOINT_ORIGIN`/`MIKIKO_UPDATE_DOWNLOAD_ORIGIN`。
- manifest provider 默认 endpointOrigin → 自建；forceUpdateGuard 同（与账号后端 zcode.z.ai 解耦）。
- electron-builder generic publish 占位 → `https://agent-dl.mikiko.ai/feed`。
- `ZCODE_UPDATES_ENABLED = true`（已恢复）；生产 flavor 生效。

## CI secrets（需手动配置）

| Secret                 | 用途                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `UPDATE_PUBLISH_TOKEN` | 发布 feed（值见 `~/.mikiko/update-publish-token.txt`，与 Worker secret PUBLISH_TOKEN 相同） |
| `CLOUDFLARE_API_TOKEN` | Pages 手机页 + update Worker 部署（需 Workers Scripts Write + Pages Write）                 |
| `RELAY_DEPLOY_KEY`     | VPS 中继 SSH 私钥（`~/.ssh/id_ed25519_termius`）                                            |

未配置时对应 job 以 exit 78 跳过并提示，互不阻塞。

## 发布流程

1. 打 tag `v1.x.y` → release-desktop.yml 构建 4 平台 + Release 发布 + publish-update-feed job 上传 R2。
2. 强更/灰度：`curl -X PUT .../admin/configs -H "X-Publish-Token: ..." -d '{...}'`。
3. 回滚：重发旧版 manifest（yml）即可。
