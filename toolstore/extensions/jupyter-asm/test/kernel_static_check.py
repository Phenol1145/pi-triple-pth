#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
kernel_static_check.py —— kernel.py 协议部分静态自检（容器无 ipykernel——不 import 运行时依赖）

检查项：
  1) 语法合法（py_compile 等效——AST 解析）
  2) class PthAsmSimKernel 定义存在，且继承名含 Kernel
  3) 存在 do_execute 方法（含 subprocess.run / timeout / send_response 关键调用）
  4) 存在 ipykernel.kernelbase 导入语句（宿主机运行时依赖——静态可见即可）
  5) 存在 IPKernelApp.launch_instance 启动入口
  6) 语言元数据：language_info.name == 'rv32i-asm'
用法：python3 test/kernel_static_check.py [kernel.py路径]
"""
import ast
import sys
from pathlib import Path

kernel_py = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "kernel.py")
src = kernel_py.read_text()
tree = ast.parse(src)          # 语法检查（失败即抛 SyntaxError）

src_text = src
fails = []

def check(cond, msg):
    if not cond:
        fails.append(msg)

# 1) 类与继承
classes = [n for n in tree.body if isinstance(n, ast.ClassDef)]
check(any(c.name == "PthAsmSimKernel" for c in classes), "缺少 class PthAsmSimKernel")
kls = next((c for c in classes if c.name == "PthAsmSimKernel"), None)
if kls:
    bases = [ast.unparse(b) for b in kls.bases]
    check(any("Kernel" in b for b in bases), "PthAsmSimKernel 未继承 Kernel 基类: %s" % bases)
    methods = [n.name for n in kls.body if isinstance(n, ast.FunctionDef)]
    check("do_execute" in methods, "缺少 do_execute 方法")

# 2) 关键调用点
check("from ipykernel.kernelbase import Kernel" in src_text or "import ipykernel" in src_text,
      "缺少 ipykernel 导入")
check("IPKernelApp.launch_instance" in src_text, "缺少 IPKernelApp.launch_instance 启动入口")
check("subprocess.run" in src_text, "缺少 subprocess.run（bridge 子进程调用）")
check("timeout=EXEC_TIMEOUT_SECONDS" in src_text or "timeout=" in src_text,
      "缺少子进程 timeout 护栏")
check('"stream"' in src_text, "缺少 stream 消息发送")
check('"execute_result"' in src_text, "缺少 execute_result 消息发送")
check('"error"' in src_text, "缺少 error 消息发送")

# 3) 语言元数据
check("'rv32i-asm'" in src_text or '"rv32i-asm"' in src_text, "缺少 language='rv32i-asm'")

# 4) 关键协议语义：ok 为状态判据（exitCode 是数据）
check('result.get("ok")' in src_text, "缺少 ok 状态判据（exitCode 应为数据非状态）")

if fails:
    print("kernel_static_check: FAIL")
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("kernel_static_check: PASS ✔（语法 + 类结构 + 协议要点 + 语义映射）")
