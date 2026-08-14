#!/bin/bash
# docker-monitor 启动脚本（不依赖 cwd + 支持 symlink 调用）
# 用法：~/pi-platform/deploy/docker-monitor/run.sh 或 ~/.local/bin/docker-monitor（symlink）
SELF="$0"
while [ -L "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *) SELF="$(dirname "$SELF")/$LINK" ;;
  esac
done
cd "$(dirname "$SELF")" || exit 1
exec node server.js "$@"
