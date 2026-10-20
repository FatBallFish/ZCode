# 桌宠原生适配

Main manager 独占桌宠 BrowserWindow、拖拽与安装包读取；renderer 只经平台 IPC 发命令。native window 与 bubble/market 协作者仍使用既有 desktop 端口。

包哈希基于字节，不基于临时路径。安装/窗口关闭与销毁只由既有 manager 执行；契约与测试不创建真实窗口、不写个人宠物库。
