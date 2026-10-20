# Mikiko 账号登录呈现

Sub2API 服务持有站点和凭据，UI 只持有本次表单与 pending。MikikoCC 使用 Mikiko ID OIDC；普通自建 Sub2API 站点保留其账密、Turnstile 和 2FA 流程。

浏览器/原生平台动作经公开 IPlatformService，成功事件后读取同一服务投影，不复制 access token 或恢复官方产品服务端点。
