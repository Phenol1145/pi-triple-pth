/**
 * pth-memory-lib：python 记忆库源码（2026-08-11 memory 库化——独立增量）。
 *
 * 形态：库源码作为 TS 字符串模块（base64 注入 PY_RUNTIME——零转义风险、零部署依赖；
 * kernel 模式（pi-platform 容器）与 sandbox 模式（kernel-pool 复用同一 PyKernel）共用一份。
 *
 * 治理不变：PTH gateway 三层（认证/白名单/可见性过滤）不动——库只是语言侧封装。
 * bridge URL：env PTH_MEMORY_BRIDGE（kernel 模式=localhost:3000 直通；sandbox=localhost:8080 转发——spawn 时注入）。
 *
 * ⚠ 已知风险（2026-08-12 审计记录——批 3 空间治理 v2 修复）：桥 body.space 由调用方自传——
 * python/bash 库不传 space → PTH 侧 visible=isVisible(meta, undefined)=true——所有条目可见
 * （含其他空间 private 条目）。修复方向：库形态改为进程环境注入盖章（PTH_MEMORY_SPACE env）——
 * 程序无法伪造空间身份。当前仅 dev 内部任务使用，可接受。
 */

export const PTH_MEMORY_LIB_PY = `# -*- coding: utf-8 -*-
"""pth_memory — PTH 记忆访问库（python 核程序内使用）。

用法（PY_RUNTIME 已 seed 单例）：
    memory.query("SELECT kind, COUNT(*) c FROM memory_entries GROUP BY kind")
    memory.retrieve(anchors=["asp"], kinds=["capability-index"])
    memory.get("<id>")

写操作不在库内（桥只读——可见性盖章治理在 ts 空间）。
"""

import json
import os
import urllib.request
import urllib.error


class Memory:
    """PTH 记忆客户端（只读桥——query/retrieve/get）。"""

    def __init__(self, base=None, secret=None):
        self.base = base or os.environ.get(
            "PTH_MEMORY_BRIDGE", "http://localhost:8080/kernel/memory-bridge"
        )
        self.secret = secret or os.environ.get("SANDBOX_SHARED_SECRET", "")

    def _call(self, op, **kw):
        req = urllib.request.Request(
            self.base,
            data=json.dumps({"op": op, **kw}).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self.secret,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:300]
            raise RuntimeError(f"memory.{op} failed: {e.code} {body}")
        except Exception as e:
            raise RuntimeError(
                f"memory.{op} 连接失败（桥不可达 {self.base}）: {e}"
            )

    def query(self, sql):
        """只读 SQL（PTH queryReadOnly 白名单——治理在 PTH 侧）。"""
        return self._call("query", sql=sql)

    def retrieve(self, anchors=None, kinds=None, **kw):
        """锚点检索（anchors/kinds 过滤——可见性由 PTH 按 space 过滤）。"""
        return self._call("retrieve", anchors=anchors or [], kinds=kinds or [], **kw)

    def get(self, id):
        """单条获取。"""
        return self._call("get", id=id)

    def write(self, *args, **kw):
        raise RuntimeError(
            "memory.write: 记忆桥只读——写记忆请用 ts 空间（可见性盖章治理在 ts 侧）"
        )


def create_memory():
    """构造记忆单例（PY_RUNTIME seed 用）。"""
    return Memory()
`;

/** base64 编码（PY_RUNTIME 注入——exec(base64.b64decode(...)) 零转义风险） */
export const PTH_MEMORY_LIB_B64 = Buffer.from(PTH_MEMORY_LIB_PY, "utf-8").toString("base64");
