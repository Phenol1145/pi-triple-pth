#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
validate.py —— v1.3 Task 9 notebook 纯 Python（仅标准库）校验脚本。

对一份 .ipynb 做结构 + 隐藏状态校验，供无 nbclient/nbformat 的环境（或作为
执行后独立复核门）使用：

  1. 结构：nbformat == 4、cells 为数组、code cell 必备键齐备；
  2. 三扫：secrets / 宿主绝对路径 / 超限输出（默认单 output > 128 KiB）；
  3. 执行完整性（--require-executed）：所有 code cell 有 execution_count 且
     无 error 输出——历史输出不能冒充本轮执行之外的「未执行草稿」。

用法：
  python3 validate.py NOTEBOOK.ipynb [--require-executed] [--max-output-bytes N]

输出：stdout 单行 JSON 报告；全部通过退出码 0，否则 1。
"""
import json
import re
import sys

DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024

SECRET_PATTERNS = [
    re.compile(r"(?:api[_-]?key|secret|password|passwd|credential)\s*[=:]\s*['\"][^'\"]{6,}['\"]", re.I),
    re.compile(r"\btoken\s*[=:]\s*['\"][^'\"]{6,}['\"]", re.I),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bsk-[A-Za-z0-9-]{16,}\b"),
]
ABSOLUTE_PATH_PATTERN = re.compile(
    r"(?:^|[\s'\"(`=])(?:~?/(?:Users|home|var|tmp|etc|opt|root|mnt|srv|data)/[^\s'\")`]+)"
    r"|(?:^|[\s'\"(`=])(?:[A-Za-z]:\\[^\s'\")`]+)",
    re.M,
)


def cell_source(cell):
    source = cell.get("source", "")
    return "".join(source) if isinstance(source, list) else str(source)


def output_text(output):
    text = output.get("text") or output.get("evalue") or ""
    if isinstance(text, list):
        text = "".join(text)
    if not text and "data" in output:
        text = json.dumps(output["data"])
    return str(text)


def validate(notebook, require_executed, max_output_bytes):
    problems = []
    secrets = []
    absolute_paths = []
    oversized = []

    if not isinstance(notebook, dict):
        problems.append("notebook must be a JSON object")
        return problems, secrets, absolute_paths, oversized
    if notebook.get("nbformat") != 4:
        problems.append(f"nbformat must be 4, got {notebook.get('nbformat')!r}")
    cells = notebook.get("cells")
    if not isinstance(cells, list):
        problems.append("cells must be an array")
        return problems, secrets, absolute_paths, oversized

    for index, cell in enumerate(cells):
        cell_id = cell.get("id", f"cell-index-{index}")
        if cell.get("cell_type") not in ("markdown", "code", "raw"):
            problems.append(f"cell {index}: unknown cell_type {cell.get('cell_type')!r}")
            continue
        source = cell_source(cell)
        for pattern in SECRET_PATTERNS:
            match = pattern.search(source)
            if match:
                secrets.append({"cellIndex": index, "cellId": cell_id, "excerpt": match.group(0)[:80]})
        match = ABSOLUTE_PATH_PATTERN.search(source)
        if match:
            absolute_paths.append({"cellIndex": index, "cellId": cell_id, "excerpt": match.group(0)[:80]})

        outputs = cell.get("outputs") or []
        for output_index, output in enumerate(outputs):
            blob = json.dumps(output)
            if len(blob.encode("utf-8")) > max_output_bytes:
                oversized.append({"cellIndex": index, "cellId": cell_id, "outputIndex": output_index,
                                  "excerpt": f"{len(blob.encode('utf-8'))} bytes > {max_output_bytes}"})
            text = output_text(output)
            for pattern in SECRET_PATTERNS:
                m = pattern.search(text)
                if m:
                    secrets.append({"cellIndex": index, "cellId": cell_id,
                                    "outputIndex": output_index, "excerpt": m.group(0)[:80]})
            m = ABSOLUTE_PATH_PATTERN.search(text)
            if m:
                absolute_paths.append({"cellIndex": index, "cellId": cell_id,
                                       "outputIndex": output_index, "excerpt": m.group(0)[:80]})

        if require_executed and cell.get("cell_type") == "code":
            if not isinstance(cell.get("execution_count"), int):
                problems.append(f"cell {index} ({cell_id}): code cell has no execution_count — not executed this run")
            for output in outputs:
                if output.get("output_type") == "error":
                    problems.append(f"cell {index} ({cell_id}): error output {output.get('ename')!r}: {str(output.get('evalue'))[:120]}")
    return problems, secrets, absolute_paths, oversized


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    path = argv[1]
    require_executed = "--require-executed" in argv
    max_output_bytes = DEFAULT_MAX_OUTPUT_BYTES
    if "--max-output-bytes" in argv:
        idx = argv.index("--max-output-bytes")
        max_output_bytes = int(argv[idx + 1])

    try:
        with open(path, "r", encoding="utf-8") as fh:
            notebook = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "problems": [f"cannot read notebook: {exc}"]}))
        return 1

    problems, secrets, absolute_paths, oversized = validate(notebook, require_executed, max_output_bytes)
    ok = not problems and not secrets and not absolute_paths and not oversized
    print(json.dumps({
        "ok": ok,
        "problems": problems,
        "secrets": secrets,
        "absolutePaths": absolute_paths,
        "oversizedOutputs": oversized,
    }, sort_keys=True))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
