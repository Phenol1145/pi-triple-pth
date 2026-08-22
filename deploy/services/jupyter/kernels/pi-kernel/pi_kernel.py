"""Pi-Triple engine kernel provider（P5c 原型，2026-08-22）。

JupyterLab 北向消费者：kernel 不本地执行代码，cell 一律转发 engine
`POST /api/v1/kernel/notebook/execute`（浏览器 → jupyter server → engine → 执行后端）。
sessionId 在 kernel 实例内保持——同一 notebook 的 cell 共享 engine 侧 REPL 状态；
kernel restart 自然新建 session。
"""
import json
import os
import urllib.error
import urllib.request
from pprint import pformat

from ipykernel.kernelbase import Kernel


class PiKernel(Kernel):
    implementation = "pi-engine"
    implementation_version = "0.1.0"
    language = "python"
    language_version = "3"
    banner = "Pi-Triple engine kernel (python/bash/ts via /api/v1/kernel/notebook/execute)"

    @property
    def language_info(self):
        import sys

        return {
            "name": self.language,
            "version": sys.version.split()[0],
            "mimetype": "text/x-python",
            "file_extension": ".py",
        }

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.engine_api = os.environ.get("PTH_API", "http://pi-platform:3000").rstrip("/")
        self.engine_token = os.environ.get("JUPYTER_ENGINE_TOKEN", "")
        self.engine_lang = os.environ.get("JUPYTER_ENGINE_LANG", "python")
        self.session_id = None
        if not self.engine_token:
            self.log.warning("JUPYTER_ENGINE_TOKEN not set — engine calls will 401")

    def do_execute(self, code, silent, store_history=True, user_expressions=None, allow_stdin=False):
        payload = {
            "language": self.engine_lang,
            "code": code,
            "timeoutMs": 600_000,
        }
        if self.session_id:
            payload["sessionId"] = self.session_id
        request = urllib.request.Request(
            f"{self.engine_api}/api/v1/kernel/notebook/execute",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {self.engine_token}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=610) as response:
                body = json.loads(response.read().decode("utf-8"))
        except KeyboardInterrupt:
            if self.session_id:
                try:
                    cancel = urllib.request.Request(
                        f"{self.engine_api}/api/v1/kernel/notebook/cancel",
                        data=json.dumps({"sessionId": self.session_id}).encode("utf-8"),
                        headers={"content-type": "application/json", "authorization": f"Bearer {self.engine_token}"},
                        method="POST",
                    )
                    urllib.request.urlopen(cancel, timeout=10).read()
                except Exception:  # noqa: BLE001
                    pass
            if not silent:
                self.send_response(self.iopub_socket, "stream", {"name": "stderr", "text": "cell interrupted — engine session aborted（下个 cell 会自动重建会话）\n"})
            return {"status": "error", "execution_count": self.execution_count, "ename": "Interrupted", "evalue": "cell execution interrupted", "traceback": []}
        except urllib.error.HTTPError as error:
            text = error.read().decode("utf-8", "replace")[:2000]
            if not silent:
                self.send_response(self.iopub_socket, "stream", {"name": "stderr", "text": f"engine HTTP {error.code}: {text}"})
            return {"status": "error", "execution_count": self.execution_count, "ename": "EngineHTTPError", "evalue": f"HTTP {error.code}", "traceback": [text]}
        except Exception as error:  # noqa: BLE001
            if not silent:
                self.send_response(self.iopub_socket, "stream", {"name": "stderr", "text": f"engine unreachable: {error}"})
            return {"status": "error", "execution_count": self.execution_count, "ename": "EngineUnreachable", "evalue": str(error), "traceback": []}

        session_id = body.get("sessionId")
        if session_id:
            self.session_id = session_id

        stdout = body.get("stdout") or ""
        stderr = body.get("stderr") or ""
        value = body.get("value")
        error = body.get("error")
        if stdout and not silent:
            self.send_response(self.iopub_socket, "stream", {"name": "stdout", "text": stdout})
        if stderr and not silent:
            self.send_response(self.iopub_socket, "stream", {"name": "stderr", "text": stderr})
        if error and not silent:
            self.send_response(self.iopub_socket, "stream", {"name": "stderr", "text": f"{error}\n"})

        if not body.get("ok"):
            return {
                "status": "error",
                "execution_count": self.execution_count,
                "ename": "EngineExecutionError",
                "evalue": error or "execution failed",
                "traceback": [error or "execution failed"],
            }

        if value is not None and not silent:
            # C9c：表达式结果走 execute_result 渲染（JupyterLab 输出面显示 execution_count
            # + text/plain，替代裸 stdout 文本；容器/字典用 pformat 提升可读性）。
            try:
                text = pformat(value, width=88, sort_dicts=False)
            except Exception:  # noqa: BLE001
                text = repr(value)
            self.send_response(
                self.iopub_socket,
                "execute_result",
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


if __name__ == "__main__":
    from ipykernel.kernelapp import IPKernelApp

    IPKernelApp.launch_instance(kernel_class=PiKernel)
