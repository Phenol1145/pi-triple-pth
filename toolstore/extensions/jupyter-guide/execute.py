#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
execute.py —— v1.3 Task 9 clean-kernel execute-all 驱动（jupyter-guide 扩展）。

语义：等价于 Jupyter 前端的 "Restart Kernel and Run All"：
  * 从 --input 读入草稿 notebook（调用方已清空历史 outputs/execution_count——
    历史输出不能替代本轮执行记录）；
  * nbclient 启动【全新 kernel】（每次 execute() 都新建 KernelManager）顺序执行全部单元格；
  * 单元格异常/超时：记录错误、保留部分输出、notebook 照常写出（隐藏状态失败可见）；
  * 写 --output 执行后 notebook + --report 执行报告 JSON；
  * 退出码：全部单元格成功 = 0，否则 = 1（报告里 errors 非空）。

本脚本由 jupyter-runtime-adapter 复制进每个 job 的 fresh workspace 后在
执行通道（容器/宿主）内运行；不持有任何凭据，不访问宿主路径之外的资源。
"""
import argparse
import json
import os
import sys
import time

import nbformat
from nbclient import NotebookClient


def main() -> int:
    parser = argparse.ArgumentParser(description="clean-kernel execute-all driver")
    parser.add_argument("--input", required=True, help="draft notebook path (outputs pre-cleared)")
    parser.add_argument("--output", required=True, help="executed notebook path")
    parser.add_argument("--report", required=True, help="execution report JSON path")
    parser.add_argument("--kernel", default="python3", help="kernelspec name")
    parser.add_argument("--timeout", type=int, default=300, help="per-cell timeout seconds")
    args = parser.parse_args()

    nb = nbformat.read(args.input, as_version=4)
    report = {
        "schemaVersion": 1,
        "kernel": args.kernel,
        "ok": False,
        "timedOut": False,
        "cellsExecuted": 0,
        "codeCells": sum(1 for c in nb.cells if c.cell_type == "code"),
        "errors": [],
        "durationMs": 0,
    }
    started = time.time()
    client = NotebookClient(
        nb,
        timeout=args.timeout,
        kernel_name=args.kernel,
        resources={"metadata": {"path": os.getcwd()}},
    )
    try:
        client.execute()
        report["ok"] = True
    except Exception as exc:  # CellExecutionError / CellTimeoutError / kernel death
        ename = type(exc).__name__
        report["errors"].append({"ename": ename, "evalue": str(exc)[:2000]})
        if "Timeout" in ename or "timeout" in str(exc).lower():
            report["timedOut"] = True
    report["durationMs"] = int((time.time() - started) * 1000)
    report["cellsExecuted"] = sum(
        1 for c in nb.cells if c.cell_type == "code" and isinstance(c.get("execution_count"), int)
    )

    nbformat.write(nb, args.output)
    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=1, sort_keys=True)
        fh.write("\n")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
