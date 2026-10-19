#!/usr/bin/env bash
# macOS DMG 签名 + 公证 + staple + 验收（docs/desktop/macos-dmg-signing-notarization.md）。
#
# 用法：
#   scripts/notarize-macos.sh <path/to/xxx.dmg> [more.dmg ...]
#
# 公证凭据（三选一，按顺序探测；变量名与 electron-builder 惯例一致，本地/CI 同一套）：
#   1. APPLE_KEYCHAIN_PROFILE            —— xcrun notarytool store-credentials 预存的 profile
#   2. APPLE_API_KEY_PATH + APPLE_API_KEY_ID + APPLE_API_ISSUER
#                                        —— App Store Connect API Key（.p8 文件路径）
#   3. APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
#                                        —— Apple ID + 应用专用密码
#
# DMG 未签名时用 APPLE_SIGNING_IDENTITY（完整 "Developer ID Application: ..." 串）补签；
# 已签名则直接进入公证。流程：codesign 校验/补签 → notarytool submit --wait →
# stapler staple → codesign/stapler/spctl 三重验收；同目录下的 .app 一并做
# deep 校验（不公证 .app 本体——DMG 公证结果覆盖包内 app，装出后由 staple 的 DMG
# 与系统在线校验共同兜底）。
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <dmg> [dmg ...]" >&2
  exit 64
fi

notary_args=()
if [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  notary_args=(--keychain-profile "$APPLE_KEYCHAIN_PROFILE")
elif [ -n "${APPLE_API_KEY_PATH:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  notary_args=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
else
  echo "::error::缺少公证凭据（APPLE_KEYCHAIN_PROFILE / APPLE_API_KEY_* / APPLE_ID 三选一）。已签名的 DMG 不允许跳过公证直接发布（Gatekeeper 会拦截）。" >&2
  echo "  本地推荐：xcrun notarytool store-credentials mikiko-notary --apple-id <id> --team-id <team> --password <app-specific-password>" >&2
  exit 1
fi

sign_identity="${APPLE_SIGNING_IDENTITY:-}"

for dmg in "$@"; do
  if [ ! -f "$dmg" ]; then
    echo "::error::DMG 不存在: $dmg" >&2
    exit 66
  fi

  echo "==> [1/4] DMG 签名校验: $dmg"
  if codesign --verify "$dmg" 2>/dev/null; then
    echo "    已有有效签名，跳过补签"
  else
    if [ -z "$sign_identity" ]; then
      echo "::error::DMG 未签名且未设置 APPLE_SIGNING_IDENTITY，拒绝提交公证（Gatekeeper 会判 source=no usable signature）" >&2
      exit 1
    fi
    echo "    用 $sign_identity 补签 DMG"
    codesign --sign "$sign_identity" --timestamp "$dmg"
    codesign --verify "$dmg"
  fi

  echo "==> [2/4] 提交公证（--wait）: $dmg"
  # submit 直接原地等待；失败时打印完整 JSON 便于排查（含 DevID 与日志引用）。
  xcrun notarytool submit "$dmg" "${notary_args[@]}" --wait

  echo "==> [3/4] staple: $dmg"
  xcrun stapler staple "$dmg"

  echo "==> [4/4] 验收: $dmg"
  codesign --verify "$dmg"
  xcrun stapler validate "$dmg"
  spctl -a -t open --context context:primary-signature -v "$dmg"
  echo "    OK: $dmg 已签名 + 公证 + staple"
done

# 同产物 .app 的本地 deep 校验（DMG 公证覆盖包内 app；这里只验证签名链与 Gatekeeper 评估）。
app_dir="${DMG_APP_DIR:-$(dirname "$1")}"
for app in "$app_dir"/mac*/Mikiko*.app "$app_dir"/mac-*/Mikiko*.app; do
  [ -d "$app" ] || continue
  echo "==> .app 校验: $app"
  codesign --verify --deep --strict "$app" >/dev/null 2>&1 || { echo "::error::codesign --deep --strict 失败: $app" >&2; exit 1; }
  spctl -a -vv -t exec "$app" >/dev/null 2>&1 || { echo "::error::spctl 评估失败: $app" >&2; exit 1; }
  echo "    OK: $app"
  break
done

echo "全部完成。"
