/**
 * 桌面端对外「下载/发布」链接的唯一出口。
 *
 * Mikiko 阶段的分发渠道是 GitHub Releases（与 changelog 一致）；
 * 官网下载页上线后，如需按语言分流再回到 main 进程集中改这里，不得在调用点手写第二份 URL。
 */
export const DESKTOP_RELEASES_DOWNLOAD_URL = "https://github.com/FatBallFish/ZCode/releases";
