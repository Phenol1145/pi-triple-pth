#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PthAsmSimKernel —— RV32I (asm-sim) Jupyter kernel 适配器（v1 验证）

协议映射（最小闭环——PTH 核与 Jupyter 协议语义可桥接的验证）：
    execute_request
      ├─ status(busy)               ← ipykernel KernelBase 自动发送
      ├─ stream(name=stdout)        ← 模拟结果 stdout（若有）
      ├─ stream(name=stderr)        ← 模拟结果 stderr（若有）
      ├─ execute_result             ← simulate().ok == true
      │                              （text/plain = stdout + exit/steps 摘要）
      │  或 error                    ← ok == false（ename=SimulationError）
      │                              或桥/子进程失败（ename=BridgeError）
      └─ status(idle)               ← ipykernel KernelBase 自动发送
    execute_reply：status=ok | error

语义约定（已对 rv32i-sim.js 实测）：
    simulate() 返回 {ok, stdout, stderr, exitCode, steps, error?}。
    * ok 是【模拟状态】：ok=true 表示程序正常跑到终点（SYS_exit 退出）——
      此时 exitCode 是【数据】（如 ecall exit(42) → ok=true, exitCode=42），
      应走 execute_result 而非 error（与验收：exit 42 的 execute_reply + 无 error 一致）。
    * ok=false 表示模拟错误（汇编失败/PC 越界/非法指令/超时等）——走 error 消息。

部署形态：模式 A（本地 jupyter 宿主机——kernel 独立进程——不连 PTH——v1 纯探索）。
运行时依赖（宿主机提供）：python3 + ipykernel + node（bridge.js 走子进程）。
无 stdin/comm 需求——缺省即可（ipykernel KernelBase 已处理 busy/idle/心跳）。

v1.3 Task 9 备注：可执行教程走 jupyter-guide 扩展的 python3 clean-kernel
execute-all（toolstore/extensions/jupyter-guide/execute.py），本探索核不参与
教程执行链路；此处仅清理重复的 language_info 死赋值。
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from ipykernel.kernelbase import Kernel
except ImportError:
    # 容器内无 ipykernel：仅允许静态自检（py_compile / AST）——运行时由宿主机提供
    Kernel = object

EXEC_TIMEOUT_SECONDS = 10.0   # 子进程护栏（模拟器自身另有 timeoutMs/maxSteps）
BRIDGE_TIMEOUT_MS = 2000      # 传给 bridge → simulate 的 timeoutMs（与模拟器默认一致）


class PthAsmSimKernel(Kernel):
    """RV32I 汇编 Jupyter kernel：execute_request → node bridge.js 子进程 → 协议消息。"""

    implementation = "pth-asm-sim"
    implementation_version = "0.1.1"   # v1.3 Task 9：去除重复 language_info 死赋值
    language = "rv32i-asm"
    language_version = "0.1.0"
    language_info = {
        "name": "rv32i-asm",
        "mimetype": "text/plain",
        "file_extension": ".s",
        "pygments_lexer": "asm",
        "codemirror_mode": "gas",
    }
    banner = "RV32I (asm-sim) kernel — asm-sim 探索核 Jupyter 适配器 v1（模式 A：本地独立进程）"

    def __init__(self, **kwargs):
        super(PthAsmSimKernel, self).__init__(**kwargs)
        self._bridge = self._resolve_bridge()
        self._node = shutil.which("node") or "node"

    # ── 内部：桥定位 / 子进程调用 ─────────────────────────────────
    @staticmethod
    def _resolve_bridge():
        """bridge.js 定位：env PTH_ASM_BRIDGE 优先；缺省 kernel.py 同目录。"""
        env = os.environ.get("PTH_ASM_BRIDGE")
        if env and env.strip():
            return env
        return str(Path(__file__).resolve().parent / "bridge.js")

    def _run_bridge(self, code):
        """node bridge.js <stdin 源码> → stdout 单行 JSON。超时/解析失败抛异常。"""
        proc = subprocess.run(
            [self._node, self._bridge],
            input=code,
            capture_output=True,
            text=True,
            timeout=EXEC_TIMEOUT_SECONDS,
        )
        out = (proc.stdout or "").strip()
        if not out:
            detail = (proc.stderr or "").strip()
            raise ValueError("bridge 无输出" + (": " + detail[:300] if detail else ""))
        try:
            return json.loads(out)
        except ValueError as e:
            raise ValueError("bridge 输出非 JSON（%s）: %s" % (e, out[:300]))

    # ── Jupyter 协议入口 ────────────────────────────────────────
    def do_execute(self, code, silent, store_history=True, user_expressions=None,
                   allow_stdin=False):
        """execute_request → 模拟 → stream/execute_result|error → reply dict。"""
        try:
            result = self._run_bridge(code)
        except subprocess.TimeoutExpired:
            return self._reply_error(
                "SimulationError",
                "模拟超时（>%gs——bridge 子进程护栏）" % EXEC_TIMEOUT_SECONDS,
                silent,
            )
        except Exception as e:
            return self._reply_error("BridgeError", str(e), silent)

        if result.get("ok"):
            stdout = result.get("stdout") or ""
            stderr = result.get("stderr") or ""
            if not silent:
                if stdout:
                    self.send_response(self.iopub_socket, "stream",
                                       {"name": "stdout", "text": stdout})
                if stderr:
                    self.send_response(self.iopub_socket, "stream",
                                       {"name": "stderr", "text": stderr})
            # execute_result：text/plain = stdout + exit/steps 摘要（exitCode 是数据非状态）
            summary = "[asm-sim] exit=%s steps=%s" % (
                result.get("exitCode", 0), result.get("steps", "?"))
            text = stdout
            if text and not text.endswith("\n"):
                text += "\n"
            text += summary + "\n"
            if not silent:
                self.send_response(
                    self.iopub_socket, "execute_result",
                    {
                        "execution_count": self.execution_count,
                        "data": {"text/plain": text},
                        "metadata": {},
                    },
                )
            return {
                "status": "ok",
                "execution_count": self.execution_count,
                "payload": [],
                "user_expressions": {},
            }

        # ok=false：模拟错误（汇编失败 / PC 越界 / 非法指令 / 模拟超时等）
        err = result.get("error") or "模拟失败（无错误详情）"
        return self._reply_error("SimulationError", err, silent)

    def _reply_error(self, ename, evalue, silent):
        """统一 error 消息 + error reply。"""
        tb = ["%s: %s" % (ename, evalue)]
        if not silent:
            self.send_response(self.iopub_socket, "error",
                               {"ename": ename, "evalue": evalue, "traceback": tb})
        return {
            "status": "error",
            "execution_count": self.execution_count,
            "ename": ename,
            "evalue": evalue,
            "traceback": tb,
        }


if __name__ == "__main__":
    # 标准 ipykernel 启动入口：python3 kernel.py -f {connection_file}
    from ipykernel.kernelapp import IPKernelApp
    IPKernelApp.launch_instance(kernel_class=PthAsmSimKernel)
