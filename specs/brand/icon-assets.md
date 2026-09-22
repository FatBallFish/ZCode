# Mikiko 跨平台应用图标规范

## 目标

保留现有黑色圆角方块与白色 `M` 主体，移除原图中烘焙的透明棋盘格和外围投影。所有桌面与 Web 图标必须从同一原始主体确定性派生，不能依赖运行时 CSS、系统遮罩或颜色阈值补救白边。

## 资源所有权

- `brand/mikiko/new-icon/master-1024.png` 是原始 RGB 输入，只用于提取主体，不直接发布。
- `brand/mikiko/tools/build-new-icon.mjs` 是所有发布图标的唯一写入路径。
- `brand/mikiko/master-icon-1024.png` 是 Windows、Linux 和 Web 的透明便携母版。
- `brand/mikiko/master-icon-macos-1024.png` 是 macOS 专用透明母版。
- `packages/desktop/build`、`packages/web/public` 与 `public/logo/icons` 中的文件都是派生产物，不得手工单独修改。

## 产品规则

1. 主体视觉保持原图的黑色圆角方块、细边框和白色 `M`，不保留主体外侧投影。
2. 原始 RGB 图的主体裁切区域固定记录在构建脚本中；新母图若改变构图，必须显式更新裁切参数和测试。
3. macOS 图标主体占画布约 `824/1024`，四周透明，由系统负责 Dock 阴影。
4. Windows、Linux 和 Web 图标主体占画布约 `896/1024`，兼顾任务栏、启动器以及 16/32px favicon 的辨识度。
5. PNG、ICNS 和 ICO 的角落必须透明；任何派生产物都不能包含烘焙棋盘格或白色外圈。
6. Windows ICO 包含 256、128、64、48、32、16px；Web favicon 包含 32、16px，并保留 PNG alpha。
7. Linux hicolor 目录的文件实际尺寸必须与目录/文件名声明一致。
8. Web HTML 内嵌 favicon 与 `packages/web/public/favicon.ico` 必须由同一次构建产生且字节一致。

## 平台加载边界

- macOS：应用包使用 `icon.icns`；运行时 `app.dock.setIcon` 使用随包的 `icon_macos.png`，不得探测未打包的旁路资源。
- Windows：可执行文件、窗口和任务栏使用 `icon.ico` / `icon_windows.png`；透明边缘必须由资产自身提供。
- Linux：electron-builder hicolor 图标与 AppImage 用户级安装图标使用便携 PNG 阶梯；desktop entry 的图标名保持现有产品身份规则。
- Web：静态 `favicon.ico` 与首屏内嵌 data URL 使用同一 favicon 数据。

## 失败语义

- 输入母图不存在、尺寸不是 1024x1024，或派生工具执行失败时，构建立即失败，不保留“部分更新”的成功提示。
- 构建后若透明度、尺寸、ICO 帧或目标同步不满足约束，资产验收测试失败。
- 运行时找不到 macOS 专用 PNG 时不再尝试同目录猜测；构建配置负责确保资源存在。

## 验收场景

1. 在透明/浅色/深色背景上查看 1024px 母版，主体外没有棋盘格、投影或浅色晕边。
2. macOS Dock 中主体大小接近系统应用，边缘由系统渲染且无白边。
3. Windows 任务栏、开始菜单和安装器图标四角透明，16/32px 图标仍可辨认。
4. Linux AppImage、deb、rpm、pacman 的 hicolor 图标尺寸正确且四角透明。
5. Chrome、Safari、Firefox 标签页 favicon 无白色方形背景。
