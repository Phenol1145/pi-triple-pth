#!/bin/sh
# T2 占位：真实住户在 T3 迁移轮安装（pth tools run 会得到明确 127 退出与提示）。
TOOL=$(basename "$0")
echo "$TOOL: not installed in this image (T3 迁移轮安装)" >&2
exit 127
