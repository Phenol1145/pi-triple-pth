#!/bin/bash
# monitor-docker-resources.sh —— 重量级测试/验收前的 Docker 资源预检与持续采样。
#
# 用法：
#   scripts/monitor-docker-resources.sh               # 单次快照（测试前预检）
#   scripts/monitor-docker-resources.sh --watch 20 60 # 每 20s 采样，最多 60 轮（测试中后台跑）
#
# 输出不含任何凭据，只有容器名/内存/CPU/容器数；可直接重定向到日志。
set -euo pipefail

WATCH_INTERVAL="${1:-0}"
if [ "$WATCH_INTERVAL" = "--watch" ]; then
  WATCH_INTERVAL="${2:-20}"
  MAX_ROUNDS="${3:-180}"
else
  WATCH_INTERVAL="0"
  MAX_ROUNDS=1
fi

snapshot() {
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') containers=$(docker ps -q | wc -l | tr -d ' ') ====="
  docker info --format 'docker memTotal={{.MemTotal}} running={{.ContainersRunning}}' 2>/dev/null || true
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}' 2>/dev/null \
    | grep -v '^k8s' | head -25 || true
}

round=0
while [ "$round" -lt "$MAX_ROUNDS" ]; do
  snapshot
  round=$((round + 1))
  if [ "$round" -lt "$MAX_ROUNDS" ] && [ "$WATCH_INTERVAL" != "0" ]; then
    sleep "$WATCH_INTERVAL"
  fi
done
