# 主题皮肤 Main 存储

单一 service 负责 Mikiko theme-skins 库、壁纸 staging 与原子替换；renderer 只读取共享记录并通过 IPC 发命令。主题选择不成为文件存储服务的第二份事实。

路径必须限制在注入的库根，导入验证与大小限制沿用 shared schema。测试只使用不存在的隔离路径，不修改正式库。
