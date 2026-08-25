#!/usr/bin/env bash
# 并行车道 worktree 初始化（2026-08-18 fork-session 协议——docs/pth/parallel-lanes.md）
# 用法：scripts/ops/lane-worktrees.sh [l1|l2|l3|l4]（缺省全部）
set -euo pipefail
cd "$(dirname "$0")/.."

# bash 3.2 兼容（macOS 默认 bash 无关联数组）——dir:branch 对
LANE_PAIRS=(
  "l1:lane/l1-n14-design"
  "l2:lane/l2-staged-flow"
  "l3:lane/l3-health-docs"
  "l4:lane/l4-release"
)

branch_for() {
  local want="$1" pair
  for pair in "${LANE_PAIRS[@]}"; do
    if [ "${pair%%:*}" = "$want" ]; then printf '%s' "${pair##*:}"; return 0; fi
  done
  return 1
}

if [ $# -gt 0 ]; then
  targets=("$@")
else
  targets=(l1 l2 l3 l4)
fi

for dir in "${targets[@]}"; do
  branch="$(branch_for "$dir")" || { echo "未知 lane: $dir（可选 l1/l2/l3/l4）" >&2; exit 1; }
  if [ -d ".worktrees/$dir" ]; then
    echo "⏭️  .worktrees/$dir 已存在（跳过）"
  else
    git worktree add ".worktrees/$dir" -b "$branch"
    echo "✅ .worktrees/$dir → $branch"
  fi
done

# node_modules 软链陷阱（L2 实战教训——2026-08-18）：.gitignore 的 "node_modules/" 带尾斜杠
# 只匹配目录，不匹配同名软链 → 软链会被 git add -A 收进提交。主 gitdir info/exclude
# 加无斜杠 "node_modules"（本地排除，不进仓库——对所有 worktree 生效）。
if ! grep -qx "node_modules" .git/info/exclude 2>/dev/null; then
  echo "node_modules" >> .git/info/exclude
  echo "✅ .git/info/exclude 已加 node_modules（防软链误提交）"
fi

cat <<'EOF'

完成。快速起步（各 worktree 内软链依赖，避免重复 npm install）：
  cd .worktrees/<lane> && ln -s ../../node_modules node_modules
各 lane 会话的引导词见 docs/pth/parallel-lanes.md「fork 引导词」。
EOF
