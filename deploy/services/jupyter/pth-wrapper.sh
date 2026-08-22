#!/bin/sh
# pth CLI 轻量透传（P5，2026-08-22 用户裁决）：
#  - 宿主机 pth 依赖树（repo 根或 npm global 目录）由 compose 只读挂载到 /opt/pth-host；
#  - 入口可用 PTH_HOST_PTH_ENTRY 覆盖（生产机 npm global 前缀时指定）。
# 镜像内零 pth 字节；不可用时给出明确指引而不是静默失败。
ENTRY="${PTH_HOST_PTH_ENTRY:-/opt/pth-host/packages/pth-cli/dist/cli/pth-cli.js}"
if [ -f "$ENTRY" ]; then
  exec node "$ENTRY" "$@"
fi
echo "pth host passthrough unavailable: mount PTH_HOST_PTH_ROOT into /opt/pth-host (or set PTH_HOST_PTH_ENTRY)" >&2
exit 127
