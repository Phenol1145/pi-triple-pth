#!/usr/bin/env bash
# run_tests.sh —— jupyter-asm v1 容器自测入口
#   * node 可用 → bridge.js 集成测试（实测 exitCode/ok 语义）
#   * python3 可用 → kernel.py 静态自检（语法/类结构/协议要点——容器无 ipykernel 只做静态）
# 用法：PTH_ASM_SIM_PATH=<rv32i-sim.js 绝对路径> ./test/run_tests.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
FAIL=0

echo "=== [1/2] bridge.js 集成测试（node） ==="
if command -v node >/dev/null 2>&1; then
  if [ -n "${PTH_ASM_SIM_PATH:-}" ]; then
    node bridge_test.js || FAIL=1
  else
    echo "  skip：未设置 PTH_ASM_SIM_PATH（跳过——需模拟器绝对路径）"
  fi
else
  echo "  skip：容器无 node"
fi

echo "=== [2/2] kernel.py 静态自检（python3） ==="
if command -v python3 >/dev/null 2>&1; then
  python3 -m py_compile ../kernel.py || FAIL=1
  python3 kernel_static_check.py || FAIL=1
else
  echo "  skip：容器无 python3"
fi

echo "=== 结果：$([ $FAIL -eq 0 ] && echo ALL PASS ✔ || echo FAILED ✘) ==="
exit $FAIL
