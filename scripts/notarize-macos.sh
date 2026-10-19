#!/usr/bin/env bash
# macOS 全量签名 + DMG 公证 + staple + 验收（docs/desktop/macos-dmg-signing-notarization.md）。
#
# 用法：
#   scripts/notarize-macos.sh <path/to/xxx.dmg> [more.dmg ...]
#
# 环境变量：
#   APPLE_SIGNING_IDENTITY   完整 "Developer ID Application: ..." 串（必填）
#   APPLE_KEYCHAIN_PROFILE   公证凭据：xcrun notarytool store-credentials 预存 profile
#   APPLE_API_KEY_PATH + APPLE_API_KEY_ID + APPLE_API_ISSUER   公证凭据：ASC API Key
#   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID    公证凭据：Apple ID
#
# 签名策略（2026-10-19 终版）：
#   electron-builder identity=null（完全不签）；本脚本在独立 shell 中从内到外
#   签全部 Mach-O（无 timestamp → 不走 Apple TSA），再从已签名 .app 重建 DMG，
#   DMG 签名是唯一 TSA 请求。公证 → staple → 三重验收。
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <dmg> [dmg ...]" >&2
  exit 64
fi

identity="${APPLE_SIGNING_IDENTITY:-}"
if [ -z "$identity" ]; then
  echo "::error::缺少 APPLE_SIGNING_IDENTITY" >&2
  exit 1
fi

notary_args=()
if [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  notary_args=(--keychain-profile "$APPLE_KEYCHAIN_PROFILE")
elif [ -n "${APPLE_API_KEY_PATH:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  notary_args=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
else
  echo "::error::缺少公证凭据（APPLE_KEYCHAIN_PROFILE / APPLE_API_KEY_* / APPLE_ID 三选一）。" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
inherit_entitlements="$script_dir/../packages/desktop/build/entitlements.mac.inherit.plist"
main_entitlements="$script_dir/../packages/desktop/build/entitlements.mac.plist"

sign_macho() {
  local bin="$1"
  codesign --sign "$identity" --force --options runtime "$bin" 2>/dev/null \
    || codesign --sign "$identity" --force "$bin" 2>/dev/null \
    || echo "  warn: 签名失败 $bin" >&2
}

sign_app_bundle() {
  local app="$1"
  local resources="$app/Contents/Resources"

  echo "  [a] glm/tools/macos-window-bounds Mach-O"
  for subdir in glm tools macos-window-bounds; do
    [ -d "$resources/$subdir" ] || continue
    find "$resources/$subdir" -type f -perm +111 | while read -r bin; do
      file -b "$bin" 2>/dev/null | grep -q "Mach-O" && sign_macho "$bin"
    done
  done

  echo "  [b] asar.unpacked .node"
  if [ -d "$resources/app.asar.unpacked" ]; then
    find "$resources/app.asar.unpacked" -name "*.node" -type f | while read -r bin; do
      sign_macho "$bin"
    done
  fi

  echo "  [c] Frameworks 内可执行文件"
  find "$app/Contents/Frameworks" -perm +111 -type f 2>/dev/null | while read -r bin; do
    file -b "$bin" 2>/dev/null | grep -q "Mach-O" && sign_macho "$bin"
  done

  echo "  [d] helper .app bundles"
  find "$app/Contents/Frameworks" -name "*.app" -maxdepth 1 -type d 2>/dev/null | while read -r helper; do
    codesign --sign "$identity" --force --options runtime "$helper" 2>/dev/null \
      || echo "  warn: helper 签名失败 $helper" >&2
  done

  echo "  [e] .framework bundles"
  find "$app/Contents/Frameworks" -name "*.framework" -maxdepth 1 -type d 2>/dev/null | while read -r fw; do
    codesign --sign "$identity" --force --options runtime "$fw" 2>/dev/null \
      || echo "  warn: framework 签名失败 $fw" >&2
  done

  echo "  [f] 主 .app（hardened runtime + entitlements）"
  codesign --sign "$identity" --force --options runtime --entitlements "$main_entitlements" "$app"

  echo "  [g] deep strict 验证"
  codesign --verify --deep --strict "$app"
  echo "  .app 签名完成"
}

for dmg in "$@"; do
  [ -f "$dmg" ] || { echo "::error::DMG 不存在: $dmg" >&2; exit 66; }
  dist_dir="$(dirname "$dmg")"

  echo "==> [1/4] .app 全量签名"
  signed_app=""
  for appdir in "$dist_dir"/mac*/Mikiko*.app; do
    if [ -d "$appdir" ]; then
      echo "  找到: $appdir"
      sign_app_bundle "$appdir"
      signed_app="$appdir"
      break
    fi
  done

  echo "==> [2/4] 从已签名 .app 重建 DMG"
  if [ -n "$signed_app" ]; then
    app_name="$(basename "$signed_app" .app)"
    new_dmg="$dist_dir/${app_name}-rebuild.dmg"
    hdiutil create -volname "$app_name" -srcfolder "$signed_app" -ov -format UDZO "$new_dmg" 2>/dev/null
    [ -f "$new_dmg" ] && mv "$new_dmg" "$dmg" && echo "  DMG 重建完成: $dmg"
  fi

  echo "==> [3/4] DMG 签名（唯一 TSA 请求）+ 公证 + staple"
  codesign --sign "$identity" --force --timestamp "$dmg"
  codesign --verify "$dmg"

  if ! submit_output=$(xcrun notarytool submit "$dmg" "${notary_args[@]}" --wait 2>&1); then
    echo "$submit_output"
    submission_id=$(printf '%s' "$submit_output" | sed -n 's/^  id: \([0-9a-f-]\{36\}\)$/\1/p')
    if [ -n "$submission_id" ]; then
      echo "==> 公证日志 ($submission_id):"
      xcrun notarytool log "$submission_id" "${notary_args[@]}" || true
    fi
    exit 1
  fi
  echo "$submit_output"
  xcrun stapler staple "$dmg"

  echo "==> [4/4] 验收: $dmg"
  codesign --verify "$dmg"
  xcrun stapler validate "$dmg"
  spctl -a -t open --context context:primary-signature -v "$dmg"
  echo "  OK: $dmg 已签名 + 公证 + staple"
done

echo "全部完成。"
