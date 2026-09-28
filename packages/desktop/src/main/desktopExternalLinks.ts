/**
 * 桌面端对外「下载/发布」链接的唯一出口。
 *
 * Mikiko 阶段的分发渠道是 GitHub Releases；
 * 官网下载页上线后，如需按语言分流再回到 main 进程集中改这里，不得在调用点手写第二份 URL。
 */
export const DESKTOP_RELEASES_DOWNLOAD_URL = "https://github.com/FatBallFish/ZCode/releases";

/**
 * 帮助菜单「更新日志」的外链出口（2026-09-28 改）：应用内更新日志统一指向自建官网
 * https://agent.mikiko.ai/changelog（packages/mikiko-cloud/public/changelog.html，
 * Workers assets 漂亮路径）；GitHub Releases 仍保留为安装包分发页。
 */
export const MIKIKO_CHANGELOG_URL = "https://agent.mikiko.ai/changelog";
