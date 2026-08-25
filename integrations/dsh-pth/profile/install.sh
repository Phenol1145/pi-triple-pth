#!/usr/bin/env bash
# install.sh —— 安装/更新 PTH interface 模式 profile
# ==================================================
# 用法：
#   ./install.sh [profile-name]
#
# 默认安装到 ~/.dsh/profiles/pth（或 $DSH_HOME/profiles/pth）。
# 脚本会：
#   1. 创建 profile 目录；
#   2. 写入 package.json（bundles: dsh-base + dsh-headless）、pnpm-workspace.yaml、cordis.patch.yml；
#   3. 把本仓库的 @pth/dsh-interface-plugin 打成 tarball 并安装为 profile 依赖。
#
# 为什么用 pnpm pack 而不是 `dsh plugin --profile pth add <dir>`：
# pnpm 对本地目录依赖默认创建 symlink；symlink 指向仓库内插件时，Node 会按仓库真实路径
# 解析依赖，找不到 dsh profile 提供的 @deepseek-ai/schemastery / @deepseek-ai/dsh-tools。
# 打成 tarball 后插件实体位于 profile/node_modules 下，能正常沿上级目录找到共享依赖。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/../plugin"
PROFILE_NAME="${1:-pth}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE_NAME"

if [[ ! -d "$PLUGIN_DIR" || ! -f "$PLUGIN_DIR/package.json" ]]; then
  echo "错误：找不到插件目录 $PLUGIN_DIR（应包含 package.json）" >&2
  exit 1
fi

# 选择 pnpm：优先系统 pnpm，其次 corepack，最后 npx。
run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  elif command -v corepack >/dev/null 2>&1 && corepack pnpm --version >/dev/null 2>&1; then
    corepack pnpm "$@"
  else
    npx --yes pnpm "$@"
  fi
}

echo "==> 准备 profile: $PROFILE_NAME"
mkdir -p "$PROFILE_DIR"

# 模板文件：package.json / pnpm-workspace.yaml 只写一次；cordis.patch.yml 总是同步模板并备份旧的。
if [[ ! -f "$PROFILE_DIR/package.json" ]]; then
  cp "$SCRIPT_DIR/package.json" "$PROFILE_DIR/package.json"
  echo "    已创建 $PROFILE_DIR/package.json"
fi
if [[ ! -f "$PROFILE_DIR/pnpm-workspace.yaml" ]]; then
  cp "$SCRIPT_DIR/pnpm-workspace.yaml" "$PROFILE_DIR/pnpm-workspace.yaml"
  echo "    已创建 $PROFILE_DIR/pnpm-workspace.yaml"
fi
if [[ -f "$PROFILE_DIR/cordis.patch.yml" ]]; then
  backup="$PROFILE_DIR/cordis.patch.yml.bak.$(date +%s)"
  cp "$PROFILE_DIR/cordis.patch.yml" "$backup"
  echo "    已备份旧 patch 到 $backup"
fi
cp "$SCRIPT_DIR/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
echo "    已写入 $PROFILE_DIR/cordis.patch.yml"

# 打包并安装本地插件。tarball 放在 profile 目录下（而非 /tmp），
# 这样 profile 的 package.json 依赖路径是稳定的，之后手动 pnpm install 也不会失效。
PACK_DIR="$PROFILE_DIR/.plugin-packs"
mkdir -p "$PACK_DIR"
rm -f "$PACK_DIR"/*.tgz
echo "==> 打包插件: $PLUGIN_DIR"
(cd "$PLUGIN_DIR" && run_pnpm pack --pack-destination "$PACK_DIR" >/dev/null)
TGZ="$(ls "$PACK_DIR"/*.tgz | head -1)"
if [[ -z "$TGZ" ]]; then
  echo "错误：插件打包失败" >&2
  exit 1
fi

# 先移除旧版本（旧版本可能指向已删除的 tarball 路径），再安装新 tarball。
if grep -q '"@pth/dsh-interface-plugin"' "$PROFILE_DIR/package.json"; then
  echo "==> 移除旧插件依赖..."
  (cd "$PROFILE_DIR" && run_pnpm remove @pth/dsh-interface-plugin >/dev/null)
fi

echo "==> 安装插件 tarball: $TGZ"
(cd "$PROFILE_DIR" && run_pnpm add "$TGZ")

echo
echo "安装完成。接下来可验证："
echo "  dsh --dump-config --profile $PROFILE_NAME"
echo "  export PTH_TOKEN=<token>   # 也可在 shell 环境或 .env 提供"
echo "  dsh --profile $PROFILE_NAME \"给 developer 发个任务算 21*2 并等结果\""
