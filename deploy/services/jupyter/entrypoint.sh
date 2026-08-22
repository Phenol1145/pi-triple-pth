#!/bin/sh
# 北面 JupyterLab 与南面 execution 服务同容器共存。
set -e

node /opt/jupyter-south/server/south-server.mjs &
SOUTH_PID=$!
trap 'kill "$SOUTH_PID" 2>/dev/null || true' EXIT

exec jupyter lab \
  --ip=0.0.0.0 \
  --port=8888 \
  --no-browser \
  --allow-root \
  --ServerApp.token='' \
  --ServerApp.password='' \
  --notebook-dir=/data/workspaces
