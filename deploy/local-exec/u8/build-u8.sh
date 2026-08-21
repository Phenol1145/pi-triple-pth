#!/bin/sh
# u8 VM 本地执行器工具链构建（宿主；Windows 主机可直接用团队的 u8.exe）
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=${U8_OUT:-"$DIR/u8"}
cc -O2 -I "$DIR/U8final_C" "$DIR"/U8final_C/*.c -o "$OUT"
echo "u8 built: $OUT"
