# Windows NVIDIA「高性能处理器」按程序开启失败排查与适配结论

> 2026-10-13。触发背景：客户反馈 Windows 版 Mikiko 无法在 NVIDIA 控制面板里开启
> 「高性能 NVIDIA 处理器」，添加程序时面板提示「拒绝方案 无法应用选定的设置到您的系统」。

## 结论速览

| 问题 | 结论 |
| --- | --- |
| Mikiko 是否支持 GPU 页面加速 | **支持**。Chromium 硬件加速默认开启（设置-基础-Chrome 硬件加速），GPU 进程正常参与渲染与合成。 |
| NVIDIA 面板「拒绝方案」是否为 Mikiko 缺陷 | **不是**。混合显卡（Optimus：核显 + 独显）笔记本上，按应用的 GPU 偏好由 Windows 图形设置统一接管，NVIDIA 驱动面板的按程序指定在这类机器上普遍被系统拒绝——对所有 Electron/Chromium 应用表现一致，与本应用无关。 |
| 应用侧能否适配 | **能，已适配**（v1.1.2 起）。新增设置「高性能 GPU 优先」（Chromium `force_high_performance_gpu`），与 NVIDIA 面板等效且不受上述系统限制；默认关闭以保持省电，开启后需重启应用。 |

## 一、客户现场还原

客户机器为混合显卡笔记本（AMD 核显 + RTX 2050），外接 1080p 屏拖动桌面宠物流畅、
回到 2560×1600 内屏拖动卡顿。现场核查（见《宠物拖动问题》报告）确认：

- Mikiko 硬件加速开启，GPU 进程正常工作；
- RTX 2050 基本未参与渲染，桌面合成走核显/内屏输出路径；
- NVIDIA 控制面板为 Mikiko.exe 指定「高性能 NVIDIA 处理器」时报
  「拒绝方案 无法应用选定的设置到您的系统」。

## 二、「拒绝方案」根因

1. **Windows 10 1703+ 的按应用 GPU 偏好是 OS 级能力**（设置 → 系统 → 屏幕 → 显示卡），
   由系统调度 D3D 设备的选择；NVIDIA 面板的同名功能在这套机制下只对少数白名单/
   非混合显卡场景生效。
2. **Optimus/混合显卡笔记本**上，独显由 OS 按需调度（渲染 offload），驱动面板无法
   越过 OS 强制绑定；点击「应用」即被系统拒绝——这是 NVIDIA 面板与 Windows 的
   既有兼容性行为，非应用可修复的缺陷。
3. 正确的系统侧做法：Windows 设置 → 系统 → 屏幕 → 显示卡 → 浏览添加
   `%LOCALAPPDATA%\Programs\Mikiko\Mikiko.exe`（按实际安装位置；NSIS 安装器允许
   自定义目录，也可装到 Program Files）→ 选项 → 高性能。

## 三、应用侧适配（本次已实现）

Electron/Chromium 提供与驱动面板等效的启动开关
[`--force_high_performance_gpu`](https://electronjs.org/docs/latest/api/command-line-switches)
（多 GPU 时强制使用独显；仅影响 Chromium GPU 进程的适配器选择，Windows 混合显卡上
实测有效）。本次落地：

- 新增设置 `desktopChromiumHighPerformanceGpuEnabled`（默认关闭）：
  - 协议/zod/设置页开关（「高性能 GPU 优先」，紧邻「Chrome 硬件加速」）；
  - main 进程最早期 bootstrap 读取并 `appendSwitch("force_high_performance_gpu")`——
    与硬件加速开关同模式（Chromium GPU 初始化只发生在 app ready 前，改后需重启）；
  - 默认关闭的原因：独显常驻会明显增加笔记本功耗与发热，仅让确有需要的用户开启
    （文档与设置描述均注明用途）。
- 顺带缓解了触发本问题的宠物拖动卡顿（另一独立修复）：拖拽期间冻结宠物 canvas
  重绘、同帧去重、气泡跟随降频，降低透明窗合成负载；若仍不满足再引导用户开启本开关。

## 四、边界与不做的事

- **macOS**：GPU 选择由操作系统管理，该 switch 在 macOS 上不可靠，不做承诺；
  设置项对 macOS 用户同样可见但不做平台差异化文案（行为等价于未开启）。
- **Linux**：混合显卡走 `switcheroo-control`/DRI PRIME，应用侧无统一开关；已有
  AppImage GPU 参数 allowlist 方案（`desktopLinuxDeepLinkRegistration.ts`）覆盖
  极端驱动场景。
- 不将 `force_high_performance_gpu` 设为默认开启（功耗取舍，见上）。
- NVIDIA 面板自身的「拒绝方案」提示属于驱动与 OS 的交互，应用侧无法也无需修复。

## 五、验收

1. 混合显卡 Windows 机器：设置开启「高性能 GPU 优先」→ 重启 → 任务管理器-性能-GPU
   可见 Mikiko GPU 进程迁移到独显（或 `chrome://gpu` 的 adapter 变化）。
2. 关闭该开关重启 → 回到核显路径（省电默认）。
3. Windows 图形设置按应用指定「高性能」与该开关叠加时行为一致（均指向独显）。
