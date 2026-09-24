#!/usr/bin/env bash
# Cloudflare 边缘模式：把部署产物中的手机页静态目录（web/）发布到 Cloudflare Pages。
# 前置：已 `wrangler login`（或设置 CLOUDFLARE_API_TOKEN），且已在 dash 创建同名 Pages 项目。
# 用法：PROJECT=mikiko-remote ./deploy-pages.sh [静态目录，默认 ./web]
set -euo pipefail

: "${PROJECT:?需要设置 Pages 项目名，例如 PROJECT=mikiko-remote}"
dir="${1:-web}"

if [ ! -f "$dir/index.html" ]; then
  echo "错误：$dir 下没有 index.html（应为本产物包内的手机页静态目录）" >&2
  exit 1
fi

cd "$dir"
exec npx --yes wrangler@latest pages deploy . --project-name "$PROJECT" --branch main
