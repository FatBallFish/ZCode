#!/bin/bash
# Mikiko 安装辅助脚本（随未签名 DMG 分发，注入后更名为「拖入Applications后双击我.command」）。
# 用途：用户把 Mikiko.app 拖入 Applications 文件夹后，双击本脚本清除 macOS 隔离标记并启动应用。
# 背景：正式包未做 Developer ID 签名/公证，直接打开会被 Gatekeeper 以「无法验证开发者」甚至
# 「文件已损坏」为由拦截；对 /Applications 下的应用执行 xattr -rc 清除 com.apple.quarantine
# 是 Apple 官方认可的规避方式，集中放在本脚本里向用户明示要做的事。
APP_PATH="/Applications/Mikiko.app"

echo "=============================================="
echo "   Mikiko 安装辅助脚本 / Setup Helper"
echo "=============================================="
echo

if [ ! -d "$APP_PATH" ]; then
  echo "[zh] 未找到 $APP_PATH"
  echo "     请先把本窗口所在安装盘里的 Mikiko 图标拖入 Applications 文件夹，"
  echo "     然后再双击本脚本。现在为你打开 Applications 文件夹。"
  echo "[en] Mikiko.app was not found in /Applications."
  echo "     Drag the Mikiko icon (in this installer window) into the Applications"
  echo "     folder first, then run this script again. Opening Applications for you."
  open /Applications
  echo
  read -n 1 -s -r -p "按任意键关闭 / Press any key to close..."
  echo
  exit 1
fi

echo "[zh] 正在清除隔离标记（绕过 Gatekeeper 对未签名包的拦截）..."
echo "[en] Clearing quarantine attributes (bypasses Gatekeeper for unsigned builds)..."
if xattr -rc "$APP_PATH" 2>/dev/null; then
  echo "[zh] 已清除隔离标记。"
  echo "[en] Quarantine attributes cleared."
else
  echo "[zh] 直接清除失败，尝试使用管理员权限（可能需要输入开机密码）..."
  echo "[en] Retrying with administrator privileges (login password may be required)..."
  sudo xattr -rc "$APP_PATH"
fi

echo "[zh] 正在启动 Mikiko ..."
echo "[en] Launching Mikiko ..."
open "$APP_PATH"
echo
echo "[zh] ✅ 完成！可以关闭本窗口。"
echo "[en] ✅ Done! You can close this window."
echo
read -n 1 -s -r -p "按任意键关闭 / Press any key to close..."
echo
exit 0
