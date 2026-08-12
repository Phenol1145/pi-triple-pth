#!/usr/bin/env bash
# install_kernel.sh —— 注册 RV32I (asm-sim) kernelspec 到 jupyter
#
# 用法：
#   ./install_kernel.sh [kernelspec-name]          # 缺省 name=rv32i-asm
#   PTH_ASM_SIM_PATH=/abs/path/rv32i-sim.cjs ./install_kernel.sh
#
# 行为：
#   1) 解析模拟器绝对路径（env PTH_ASM_SIM_PATH 优先；缺省 <脚本目录>/../asm-kernel/rv32i-sim.cjs）
#   2) 将绝对路径写入 kernel.json 的 env.PTH_ASM_SIM_PATH（替换 __PTH_ASM_SIM_PATH__ 哨兵）
#   3) jupyter kernelspec install 本目录 → ~/.local/share/jupyter/kernels/<name>/
#      （kernel.py / bridge.js 随目录一起复制——argv 用 {resource_dir} 占位符定位）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${1:-rv32i-asm}"

SIM="${PTH_ASM_SIM_PATH:-}"
if [ -z "$SIM" ]; then
  DEFAULT_SIM="$HERE/../asm-kernel/rv32i-sim.cjs"
  if [ -f "$DEFAULT_SIM" ]; then SIM="$DEFAULT_SIM"; fi
fi
if [ -z "$SIM" ] || [ ! -f "$SIM" ]; then
  echo "错误：找不到 rv32i-sim.cjs——请设置 PTH_ASM_SIM_PATH 或放置到 $DEFAULT_SIM" >&2
  exit 1
fi
SIM="$(cd "$(dirname "$SIM")" && pwd)/$(basename "$SIM")"

python3 - "$SIM" "$HERE" <<'PY'
import json, sys
from pathlib import Path
sim, here = sys.argv[1], sys.argv[2]
p = Path(here) / "kernel.json"
spec = json.loads(p.read_text())
spec.setdefault("env", {})
spec["env"]["PTH_ASM_SIM_PATH"] = sim
p.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n")
print("kernel.json env.PTH_ASM_SIM_PATH =", sim)
PY

echo ">> jupyter kernelspec install $HERE --name $NAME"
jupyter kernelspec install "$HERE" --name "$NAME" --replace
echo ">> 已安装 kernelspec："
jupyter kernelspec list
