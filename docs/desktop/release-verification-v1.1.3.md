# v1.1.3 发布验收记录

验收时间：2026-10-20（北京时间）

- 源构建：`39277356801`，源代码：`fce3b99351da2ea0418f79b337b5f82726c929d1`，tag：`v1.1.3`。
- arm64 公证：`b4eb1196-55ce-48b0-92b9-2fa2eca2afd6`，状态 `Accepted`。
- x64 公证：`da8881ec-0fbf-4038-9585-8f1100098256`，状态 `Accepted`。
- arm64 补充申请 `c2d14795-8a7d-42fb-80a3-fdc86818de08` 仍可处于 `In Progress`；原申请已通过，因此不阻塞发布。
- Mac 验收 run：`39366882600`；两份 proof 均确认 `Accepted`、App/DMG 已 staple、ZIP payload 已验证，最终文件哈希与 Release 资产一致。
- GitHub Release：[v1.1.3](https://github.com/FatBallFish/ZCode/releases/tag/v1.1.3)，公开且非草稿，包含 23 个资产：arm64/x64 Mac、Windows x64/arm64、Linux x64、两份 relay kit、两份 Mac 公证 proof。
- 更新 feed 恢复 run：[39371386184](https://github.com/FatBallFish/ZCode/actions/runs/39371386184)，仅运行 feed job；构建、公证、relay 和 Release job 均跳过。五个平台公开 manifest 均返回版本 `1.1.3`，URL 指向 `https://agent-dl.mikiko.ai/files/1.1.3/`，文件大小与 GitHub Release 资产一致，SHA512 来自同一批已验收安装包。

feed 过程中两次遇到 R2 multipart 分片 HTTP 503，未改变任何安装包或公证结果；增加瞬时 5xx 重试后第三次 feed 运行成功。Deploy Mikiko Cloud 初次曾因 D1 code 7403 失败，但原 run `39277357250` 的第 2 次运行已成功：D1 迁移检查通过（`No migrations to apply`），Worker 上传与 triggers 发布通过，部署版本 ID 为 `575ddd12-76d8-4504-8460-986143409bb7`。2026-10-20 复核确认该权限阻塞已解除，无需再次部署旧版本。
