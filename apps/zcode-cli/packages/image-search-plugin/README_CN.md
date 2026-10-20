# Mikiko 搜图插件

[English](./README.md)

本 Mikiko 插件暂用官方 CodingPlan 搜图 MCP 后端，让 Agent 在制作文档、演示文稿、海报或网页时检索插图与参考配图。

## 包含组件

- MCP 服务 `image_search`（HTTP），命名空间为 `plugin:image-search:image_search`。

## 使用前提

- Mikiko 当前已登录智谱 BigModel 或 Z.ai 账号；官方后端继续校验套餐权益和额度，无需手动配置 Token 或 API Key。
- 可访问官方 CodingPlan 端点；自建产品云配置不会改变此账号目的地。
- 安装或更新插件后需新建 Mikiko 会话。

## 使用方式

安装后用自然语言提出配图需求即可，例如「给封面找一张风力发电场的照片」，Agent 会调用搜图工具。
`documents`、`pdf`、`presentations` 等插件已不再内置该 MCP 服务，需要在文档制作过程中使用搜图时，
请与它们一并安装本插件。

## 说明

- 本插件仅声明 MCP 服务，不包含命令、技能、Hooks 或 Agent。
- 未登录或账号不可用时明确失败，不匿名调用付费搜索。
- 预留 custom 后端端口供未来实现，自建实现不会继承官方账号鉴权。
- 搜索结果经 CodingPlan 服务来自第三方图库，用于对外交付前请自行确认图片授权。
