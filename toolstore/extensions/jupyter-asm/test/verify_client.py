"""jupyter_client 全协议验证：KernelManager 启动 → execute → 断言消息流"""
from jupyter_client import KernelManager
import json, sys

def run_cell(km, code, timeout=30):
    kc = km.client()
    kc.start_channels()
    kc.wait_for_ready(timeout=timeout)
    msg_id = kc.execute(code)
    streams, results, errors, replies = [], [], [], []
    while True:
        msg = kc.get_iopub_msg(timeout=timeout)
        if msg["parent_header"].get("msg_id") != msg_id:
            continue
        t = msg["msg_type"]
        if t == "stream":
            streams.append((msg["content"]["name"], msg["content"]["text"]))
        elif t == "execute_result":
            results.append(msg["content"]["data"])
        elif t == "error":
            errors.append(msg["content"])
        elif t == "status" and msg["content"]["execution_state"] == "idle":
            break
    reply = kc.get_shell_msg(timeout=timeout)["content"]
    kc.stop_channels()
    return {"streams": streams, "results": results, "errors": errors, "reply_status": reply["status"]}

km = KernelManager(kernel_name="rv32i-asm")
km.start_kernel()
print("kernel started:", km.kernel_name)

# 用例 1：exit(42) → 数据（非错误）
r1 = run_cell(km, "li a0, 42\nli a7, 93\necall")
ok1 = r1["reply_status"] == "ok" and len(r1["errors"]) == 0
print("case1 exit42:", "PASS" if ok1 else f"FAIL {json.dumps(r1)[:200]}")

# 用例 2：write + exit(0) → stream stdout
r2 = run_cell(km, '''.data
msg: .asciz "hello from jupyter\\n"
.text
.globl _start
_start:
  li a0, 1
  la a1, msg
  li a2, 19
  li a7, 64
  ecall
  li a0, 0
  li a7, 93
  ecall''')
stream_text = "".join(t for _, t in r2["streams"])
ok2 = r2["reply_status"] == "ok" and "hello from jupyter" in stream_text
print("case2 write:", "PASS" if ok2 else f"FAIL {json.dumps(r2)[:250]}")

# 用例 3：非法指令 → error 消息
r3 = run_cell(km, "foobar x0, x0\n")
ok3 = r3["reply_status"] == "error" and len(r3["errors"]) > 0
print("case3 bad-asm:", "PASS" if ok3 else f"FAIL {json.dumps(r3)[:200]}")

# 用例 4：kernel_info（language 元数据）
kc = km.client(); kc.start_channels(); kc.wait_for_ready(timeout=30)
msg_id = kc.kernel_info()
reply = kc.get_shell_msg(timeout=30)
info = reply.get("content", {})
kc.stop_channels()
ok4 = info.get("language_info", {}).get("name") == "rv32i-asm"
print("case4 kernel_info:", "PASS" if ok4 else f"FAIL {json.dumps(info)[:200]}")

km.shutdown_kernel(now=True)
print("ALL:", "PASS" if all([ok1, ok2, ok3, ok4]) else "FAIL")
sys.exit(0 if all([ok1, ok2, ok3, ok4]) else 1)
