#!/bin/bash
# verify-clean-sandbox-build.sh —— sandbox 镜像干净构建验证（旧 execution-isolation Task 5 / 加固计划 S2-2）
#
# 验证两件事：
#   1. 部署描述通过 compose config 校验（SANDBOX_SHARED_SECRET / PTH_EXECUTION_GRANT_SECRET
#      的 `:?` 强校验保留——缺失即失败）
#   2. packages/pth-sandbox/Dockerfile.sandbox 能从仓库根做无缓存构建（不依赖本地 dist/开发机残留）
#
# 构建阶段不注入任何密钥；本脚本不启动容器、不改动运行中的部署。
# 用法（仓库根或任意位置）：
#   SANDBOX_SHARED_SECRET=<你的密钥> PTH_EXECUTION_GRANT_SECRET=<你的grant密钥> npm run verify:sandbox-build
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOCKERFILE="$ROOT/packages/pth-sandbox/Dockerfile.sandbox"
COMPOSE_FILE="$ROOT/deploy/docker-compose.yaml"

echo "── sandbox clean-build 验证 ──"
echo "仓库根:  $ROOT"
echo "Dockerfile: $DOCKERFILE"

if [[ ! -f "$DOCKERFILE" ]]; then
  echo "❌ 未找到 $DOCKERFILE——真实 Dockerfile 已迁入 packages/pth-sandbox/，请勿回退到仓库根旧路径" >&2
  exit 1
fi

if [[ -z "${SANDBOX_SHARED_SECRET:-}" ]]; then
  echo "❌ 缺少 SANDBOX_SHARED_SECRET——compose 使用 \${SANDBOX_SHARED_SECRET:?} 强校验，不允许默认值/空值" >&2
  echo "   请以 SANDBOX_SHARED_SECRET=<你的密钥> 方式传入；构建阶段不会把该值写入镜像。" >&2
  exit 1
fi

if [[ -z "${PTH_EXECUTION_GRANT_SECRET:-}" ]]; then
  echo "❌ 缺少 PTH_EXECUTION_GRANT_SECRET——compose 使用 \${PTH_EXECUTION_GRANT_SECRET:?} 强校验，不允许默认值/空值" >&2
  echo "   请以 PTH_EXECUTION_GRANT_SECRET=<你的grant密钥> 方式传入；构建阶段不会把该值写入镜像。" >&2
  exit 1
fi

echo "① compose config 校验（密钥只用于插值，输出不落盘）……"
(cd "$ROOT" && docker compose -f "$COMPOSE_FILE" config >/dev/null)

echo "② 无缓存构建 sandbox 镜像（不注入任何密钥）……"
IMAGE_ID="$(cd "$ROOT" && docker build --no-cache -q -f "$DOCKERFILE" .)"

if [[ -z "$IMAGE_ID" ]]; then
  echo "❌ docker build 未返回镜像 id" >&2
  exit 1
fi

echo "✅ sandbox clean build 通过：镜像 $IMAGE_ID"
