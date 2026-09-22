════════════════════════════════════════════════════════
 Mikiko 安装说明（重要，请先阅读）
════════════════════════════════════════════════════════

一、安装步骤
------------------------------------------------------------------
1. 把本窗口中的 Mikiko 图标拖入 Applications 文件夹。

2. 打开「终端」：
   应用程序 → 实用工具 → 终端
   （或按 Command+空格 打开聚焦搜索，输入“终端”或 Terminal 回车）

3. 复制下面这行命令，粘贴到终端里按回车执行：

   xattr -rc /Applications/Mikiko.app

   · 若提示 Permission denied，请改为执行（需输入开机密码）：

     sudo xattr -rc /Applications/Mikiko.app

4. 回到 Applications 文件夹，双击打开 Mikiko。

二、为什么需要执行这条命令？
------------------------------------------------------------------
当前安装包未做 Apple 开发者签名与公证，macOS 会拦截未签名应用
（提示“无法验证开发者”，甚至误报“文件已损坏”）。
上面的命令只是移除从网络下载文件时附带的隔离标记，
不修改任何系统设置，应用本身不受影响。

三、English Quick Guide
------------------------------------------------------------------
1. Drag the Mikiko icon into the Applications folder.
2. Open Terminal (Applications → Utilities → Terminal).
3. Run the following command:

   xattr -rc /Applications/Mikiko.app

   If permission denied, run instead (login password required):

   sudo xattr -rc /Applications/Mikiko.app

4. Launch Mikiko from the Applications folder.

════════════════════════════════════════════════════════
