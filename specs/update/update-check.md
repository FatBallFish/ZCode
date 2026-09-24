# 桌面更新校验（临时屏蔽）

## 现状与目标

2026-09-24：自建升级服务已上线（`specs/update/update-service.md`，agent-update/agent-dl.mikiko.ai），`ZCODE_UPDATES_ENABLED` 已恢复为 true 并指向自建端点。以下屏蔽描述仅作历史记录。此前：更新服务尚未搭建（无更新 feed、无强更配置端点）。正式包（`ZCODE_PRODUCT_FLAVOR === "production"`）不得发起任何更新校验请求，也不得展示更新入口。**这是暂时屏蔽而非移除**：更新系统就绪后，将 `packages/shared/src/env.ts` 中的 `ZCODE_UPDATES_ENABLED` 改回 `true` 即整体恢复原有接线，各入口的读取点不得单独删除。

## 状态所有者

- `ZCODE_UPDATES_ENABLED`（`packages/shared/src/env.ts`）是更新能力的唯一编译期开关，`false` 表示全 flavor 屏蔽。
- 产品身份轴（`ZCODE_PRODUCT_FLAVOR`）保持不变：恢复后仍是「production 启用、Preview 禁用」。
- 更新运行时状态的唯一所有者仍是 `packages/desktop/src/main/autoUpdater.ts` 的模块状态机；renderer 通过 `UpdateStateChanged` 等通道只读。

## 接线点（恢复时全部随开关翻转）

| 入口                                            | 文件                                                                        | 行为（开关为 `false` 时）                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| autoUpdater 初始化（启动检查、每小时轮询、IPC） | `packages/desktop/src/main/index.ts` → `initAutoUpdater({ enabled })`       | 不配置 feed、不发请求；`autoUpdaterDisabledForProductFlavor` 置位使手动检查 fail-closed |
| 启动强更 gate（`/api/v1/client/configs`）       | `packages/desktop/src/main/index.ts` → `maybeBlockStartupForForceUpdate`    | 完全跳过，不发出网请求                                                                  |
| 原生菜单「检查更新」                            | `packages/desktop/src/main/desktopApplicationMenu.ts`                       | 菜单项不出现                                                                            |
| Renderer 帮助菜单「检查更新」                   | `packages/ui/src/lib/desktopUpdateMenu.ts` → `shouldShowDesktopUpdateEntry` | 入口不出现                                                                              |

本地恢复逻辑（`hydratePendingPostUpdateReleaseNotes` 等）只读写本地设置，不出网，保持原样。

## 失败语义

- 开关为 `false` 时，任何漏改入口若仍调用 `checkForUpdateMenuClick` / `requestForceAutoUpdate`，必须在模块内部 fail-closed（返回 `dev-skipped` 或不发请求），不得对占位 feed 发真实请求。

## 验收场景

1. 正式包启动：日志无 `[auto-update] checking` / `[force-update]` 出网记录，帮助菜单与原生菜单均无「检查更新」。
2. Preview 包与本地 dev：行为与开关引入前一致（本就禁用）。
3. `ZCODE_UPDATES_ENABLED` 改回 `true` 后重新构建：启动检查、轮询、手动检查、菜单入口按产品身份恢复。
