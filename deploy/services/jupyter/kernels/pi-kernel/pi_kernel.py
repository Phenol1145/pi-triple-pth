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

    def _parse_cell_magic(self, code):
        """解析首行 cell magic：%%<lang> [target]。

        支持：
          %%python            -> language=python, target=default
          %%python sandbox    -> language=python, target=sandbox
          %%bash local-lean   -> language=bash, target=local-lean
          %%ts                -> language=ts, target=default
        未写 magic -> 返回 (self.engine_lang, None, code)。
        """
        first_line = code.split("\n", 1)[0].strip()
        if not first_line.startswith("%%"):
            return self.engine_lang, None, code
        rest = first_line[2:].strip()
        if not rest:
            raise ValueError("cell magic 必须声明语言：%%python / %%bash / %%ts")
        parts = rest.split()
        lang = parts[0]
        if lang not in ("python", "bash", "ts"):
            raise ValueError(f"不支持的 cell magic 语言: {lang}（支持 python/bash/ts）")
        target = parts[1] if len(parts) > 1 else None
        if len(parts) > 2:
            raise ValueError(f"cell magic 目标格式错误：%%{lang} [target]")
        # 去掉 magic 首行；保留后续代码（无后续代码时为空串）。
        remainder = code.split("\n", 1)[1] if "\n" in code else ""
        return lang, target, remainder

    def do_execute(self, code, silent, store_history=True, user_expressions=None, allow_stdin=False):
        try:
            language, target, cell_code = self._parse_cell_magic(code)
        except ValueError as exc:
            if not silent:
                self.send_response(self.iopub_socket, "stream", {"name": "stderr", "text": f"{exc}\n"})
            return {
                "status": "error",
                "execution_count": self.execution_count,
                "ename": "BadMagicError",
                "evalue": str(exc),
                "traceback": [str(exc)],
            }
        payload = {
            "language": language,
            "code": cell_code,
            "timeoutMs": 600_000,
        }
        if target:
            payload["target"] = target
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


    def do_shutdown(self, restart):
        """kernel 关闭时主动释放 engine 侧 notebook session（修 P5d 泄漏）。"""
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
                self.log.warning("engine session cancel on shutdown failed")
        return super().do_shutdown(restart)


if __name__ == "__main__":
    from ipykernel.kernelapp import IPKernelApp

    IPKernelApp.launch_instance(kernel_class=PiKernel)
