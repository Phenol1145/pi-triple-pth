#!/usr/bin/env bash
# 生产核 aarch64 原生冒烟（设计 §5.1）——容器已有 binutils（as/ld）
set -e
cd "$(dirname "$0")"
as hello-aarch64.s -o /tmp/hello-aarch64.o
ld /tmp/hello-aarch64.o -o /tmp/hello-aarch64
OUT=$(/tmp/hello-aarch64)
[ "$OUT" = "hello asm!" ] || { echo "FAIL: stdout='$OUT'"; exit 1; }
echo "PASS aarch64 原生冒烟（stdout='$OUT'）"
