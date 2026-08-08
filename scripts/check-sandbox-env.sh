#!/bin/bash
# sandbox 敏感信息检查（kernel sandbox SPEC §4.5 验证①③）
# ① 镜像扫描：Dockerfile.sandbox 不得含凭据字面量
# ③ 运行期断言：sandbox 容器 env 不得含业务密钥（KEY/TOKEN/SECRET/PASSWORD/URL）
#    ——SANDBOX_SHARED_SECRET 本身是沙盒认证，允许（不匹配单独 KEY 规则？见下：白名单式）
# 用法：./scripts/check-sandbox-env.sh [container-name]  （无参=只做镜像扫描）
set -u

echo "── ① Dockerfile.sandbox 凭据字面量扫描 ──"
DOCKERFILE="$(dirname "$0")/../Dockerfile.sandbox"
# 凭据字面量模式：形如 KEY=xxx / PASSWORD=xxx 的硬编码值（排除 ${VAR} 引用与注释）
HITS=$(grep -nE '(KEY|TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|DATABASE_URL)\s*=\s*[^$"'\'' ]+' "$DOCKERFILE" | grep -vE '\$\{' || true)
if [ -n "$HITS" ]; then
  echo "❌ Dockerfile.sandbox 发现疑似凭据字面量："
  echo "$HITS"
  exit 1
fi
echo "✅ 镜像无凭据字面量"

CONTAINER="${1:-}"
if [ -z "$CONTAINER" ]; then
  echo "（未指定容器名——跳过运行期断言）"
  exit 0
fi

echo "── ③ sandbox 容器运行期 env 断言（容器: $CONTAINER）──"
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "❌ 容器 $CONTAINER 不存在"
  exit 1
fi

# 白名单：sandbox 只允许这些 env（SANDBOX_SHARED_SECRET 为沙盒自身认证，允许）
ALLOWED="SANDBOX_SHARED_SECRET|LOG_LEVEL|PATH|HOME|HOSTNAME|PWD|USER|SHELL|LANG|TERM|PORT|NODE_VERSION|TZ|NODE_ENV"
# docker inspect 取 env 数组
INSPECT=$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}')
BAD=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  key="${line%%=*}"
  case "$key" in
    *KEY*|*TOKEN*|*SECRET*|*PASSWORD*|*DATABASE*) 
      if ! echo "$key" | grep -qE "^($ALLOWED)\$"; then
        BAD="$BAD\n  $key"
      fi
      ;;
  esac
done <<< "$INSPECT"

if [ -n "$BAD" ]; then
  echo "❌ sandbox 容器发现敏感 env（应为零）：$BAD"
  exit 1
fi
echo "✅ sandbox 容器 env 无业务密钥（仅允许白名单项）"
exit 0
