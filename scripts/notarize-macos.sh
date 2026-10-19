#!/usr/bin/env bash
# 最终 DMG 签名、公证、staple 和验收；App 签名由 builder 在封装前完成。
# 规则见 specs/desktop/macos-signing.md。
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
  echo "::error::缺少公证凭据（APPLE_KEYCHAIN_PROFILE / APPLE_API_KEY_* / APPLE_ID 三选一）。" >&2
  exit 1
fi

for dmg in "$@"; do
  [ -f "$dmg" ] || { echo "::error::DMG 不存在: $dmg" >&2; exit 66; }

  echo "==> [1/4] DMG 签名校验: $dmg"
  if ! codesign --verify "$dmg" 2>/dev/null; then
    if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
      echo "::error::DMG 未签名且未设置 APPLE_SIGNING_IDENTITY" >&2
      exit 1
    fi
    sign_args=(--timestamp)
    if [ -n "${CSC_KEYCHAIN:-}" ]; then
      sign_args+=(--keychain "$CSC_KEYCHAIN")
    fi
    codesign --sign "$APPLE_SIGNING_IDENTITY" "${sign_args[@]}" "$dmg"
    codesign --verify "$dmg"
  fi

  echo "==> [2/4] 提交 Apple 公证: $dmg"
  submit_exit=0
  submit_output=$(xcrun notarytool submit "$dmg" "${notary_args[@]}" --wait --output-format json) || submit_exit=$?
  printf '%s\n' "$submit_output"
  # notarytool 可能退出 0 但返回 Invalid；必须读取业务状态，不能把进程成功当作公证成功。
  submission_id=$(node -e 'try { process.stdout.write(JSON.parse(process.argv[1]).id || ""); } catch {}' "$submit_output")
  status=$(node -e 'try { process.stdout.write(JSON.parse(process.argv[1]).status || ""); } catch {}' "$submit_output")
  if [ "$submit_exit" -ne 0 ] || [ "$status" != "Accepted" ]; then
    echo "::error::公证未通过，status=${status:-unknown}，submission=$submission_id" >&2
    if [ -n "$submission_id" ]; then
      xcrun notarytool log "$submission_id" "${notary_args[@]}" || true
    fi
    exit 1
  fi

  echo "==> [3/4] staple: $dmg"
  xcrun stapler staple "$dmg"
  echo "==> [4/4] 验收: $dmg"
  codesign --verify "$dmg"
  xcrun stapler validate "$dmg"
  spctl -a -t open --context context:primary-signature -v "$dmg"
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  node "$script_dir/../packages/desktop/scripts/refresh-macos-artifact-metadata.mjs" "$dmg"
done

# 只验收封装输入，不在封装后重新签名或重建镜像；两个架构都必须检查。
app_dir="${DMG_APP_DIR:-$(dirname "$1")}"
for app in "$app_dir"/mac*/Mikiko*.app; do
  [ -d "$app" ] || continue
  echo "==> .app 验收: $app"
  codesign --verify --deep --strict "$app"
  spctl -a -vv -t exec "$app"
done
echo "全部完成。"
