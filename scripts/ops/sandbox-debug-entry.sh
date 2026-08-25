#!/usr/bin/env bash
# ============================================================================
# F/WP3 Task 14 — sandbox 自修改调试入口（在 sandbox 容器内执行）
#
# 用途：在 sandbox 容器内启动 pi / PTL（pit）会话（tmux），承载"代码执行侧"的
# 自修改调试：pi 做代理工作，PTL 联 pth hub（observe/构件上传）。
#
# 用法（宿主机执行）：
#   docker exec -it sandbox sandbox-debug-entry.sh pi [cwd]          # pi 交互会话（tmux 内）
#   docker exec -it sandbox sandbox-debug-entry.sh pit               # PTL TUI（tmux 内）
#   docker exec -it sandbox sandbox-debug-entry.sh pit <args...>     # PTL 命令直跑（如 pit hub observe）
#   docker exec -it sandbox sandbox-debug-entry.sh attach            # 附加已建 tmux 会话
#   docker exec -it sandbox sandbox-debug-entry.sh tmux ls           # 查看会话
#
# LLM 密钥操作流（用户裁决：sandbox 镜像不持任何密钥——按需临时注入，用完即撤）：
#   docker exec -it -e ANTHROPIC_API_KEY=<key> sandbox sandbox-debug-entry.sh pi
#   # 或 -e OPENAI_API_KEY=<key>。密钥仅存在于该容器进程 env；
#   # 用完即撤：exit tmux 会话并 docker rm -f sandbox（或 restart 容器）即清除。
#
# 镜像内已内嵌（Dockerfile.sandbox）：pi（node_modules bin）/ pit（dist/ptl/pit.js）/
# PTL 扩展 pit-communicate+pit-control（/data/agent-dir/extensions，PI_CODING_AGENT_DIR）。
# 注意：sandbox 仅 internal 网络——pi/pit 不能访问外网；联 pth 用 PLATFORM_URL=http://pi-platform:3000。
# ============================================================================
set -euo pipefail

TMUX_SESSION="${SANDBOX_DEBUG_SESSION:-sandbox-debug}"
DEFAULT_CWD="/data/workspaces"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 1
  fi
}

warn_missing_key() {
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "⚠  未检测到 LLM 密钥（ANTHROPIC_API_KEY / OPENAI_API_KEY 均未注入）。" >&2
    echo "    pi 会话需要密钥才有实际用途；请按脚本头注释用 docker exec -e 临时注入（用完即撤）。" >&2
  fi
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  pi)
    need_cmd pi
    need_cmd tmux
    warn_missing_key
    cwd="${1:-$DEFAULT_CWD}"
    mkdir -p "$cwd"
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
      echo "已存在会话 $TMUX_SESSION——附加：docker exec -it sandbox tmux attach -t $TMUX_SESSION"
      exit 0
    fi
    tmux new-session -d -s "$TMUX_SESSION" -c "$cwd" "pi"
    echo "pi 会话已启动（cwd=$cwd）。附加："
    echo "  docker exec -it sandbox tmux attach -t $TMUX_SESSION"
    echo "（自修改调试：pi 内可用 /pit 命令与宿主 pth 的 PTL 扩展联动）"
    ;;
  pit)
    need_cmd pit
    if [ "$#" -eq 0 ]; then
      # 无参数 → 交互式 PTL TUI（tmux 内）
      need_cmd tmux
      if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        echo "已存在会话 $TMUX_SESSION——附加：docker exec -it sandbox tmux attach -t $TMUX_SESSION"
        exit 0
      fi
      tmux new-session -d -s "$TMUX_SESSION" -c "$DEFAULT_CWD" "pit"
      echo "PTL TUI 已启动。附加：docker exec -it sandbox tmux attach -t $TMUX_SESSION"
    else
      # 带参数 → 直接执行（pit hub observe 等；非交互）
      cd "$DEFAULT_CWD"
      exec pit "$@"
    fi
    ;;
  attach)
    need_cmd tmux
    exec tmux attach -t "$TMUX_SESSION"
    ;;
  tmux)
    need_cmd tmux
    exec tmux "$@"
    ;;
  help|--help|-h|"")
    sed -n '2,40p' "$0"
    ;;
  *)
    echo "error: 未知子命令: $cmd（可用: pi | pit | attach | tmux | help）" >&2
    exit 2
    ;;
esac
