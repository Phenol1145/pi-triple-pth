# PTH 分层架构（2026-08-12 用户裁决：核心机制 / 具体实现分离）

> PTH = 自耦自然语言解释器（解释即执行）。本页只描述 PTH 的内部分层与依赖方向；与 PTL 的关系见 `docs/ptl/architecture.md`。

## 分层原则

> "尽可能把 PTH 分解开——所有核和 worker 谱系都作为一个具体实现提供。"

核心（框架/协议/机制）不绑定具体核与具体角色；具体实现（内置核、worker 谱系、内置空间）
作为独立实现层提供——可替换、可扩展、可裁剪。

```
src/pth/
├── core/          # 协议核心（agent-engine 等）
├── gateway/       # API 层（路由/鉴权/SSE）
├── kernel/        # 核心执行引擎
│   ├── execution/     # 引擎机制：agent-loop/task-loop/batch/路由/空间注册表/优化器/
│   │                 #   trigger/scorecard/workspace（不含角色定义——角色在 impls）
│   ├── interpreter/   # 核抽象：WorkerKernel 接口/types/llm-fn/toolstore/read-source/
│   │                 #   kernel-config/exec-channel/ext-capability（不含具体核）
│   ├── extensions/    # 扩展机制 + 系统扩展（ext-registry/manage/perf/obs/memory…）
│   └── storage/       # 持久化（memory/task/transcript/audit）
└── impls/          # ★ 具体实现层（2026-08-12 起）
    ├── roles/         # worker 谱系：ORIGIN/DEFAULT/MID/GOVERNANCE 角色定义
    │                 #   （核心 worker-cluster 消费——注册/展开/路由机制在核心）
    ├── spaces/        # 内置空间：registerBuiltinSpaces(registry)
    │                 #   （meta/ts/python/bash/dev/write——核心注册表装配）
    └── kernels/       # 内置核实现 + 装配
        ├── index.ts           # createWorkerKernel 装配工厂（三解释器+llm+能力包）
        ├── kernel-manager.ts  # 装配型管理器（new 具体核 + 路由/队列/超时）
        ├── ts-interpreter / python-interpreter / bash-interpreter   # 语言核
        ├── py-kernel / bash-kernel                                  # 持久 REPL
        ├── compiled-kernel / gdb-mi                                 # C 生产核 + 调试
        ├── capability / pth-memory-lib                              # ts 能力包
        └── sandbox-kernel / sandbox-compiled-kernel / sandbox-debug-session  # 沙箱核
```

## 依赖方向

```
核心（kernel/execution·interpreter·extensions）──消费──▶ 实现（impls/）
实现（impls/）──import type──▶ 核心（类型/接口——运行时无循环）
```

- 核心不 import 具体核/具体角色/内置空间定义
- 装配点：`space-registry` 调用 `registerBuiltinSpaces`；`batch-process/exec-channel`
  从 `impls/kernels` import 工厂；`worker-cluster` 消费 `impls/roles` 数据

## 替换/扩展点

| 目标 | 替换方式 |
|---|---|
| 换内置角色谱系 | 替换 `impls/roles/default-roles.ts`（或注册扩展角色） |
| 无内置空间发行版 | 移除 `space-registry.ts` 的 `registerBuiltinSpaces` 装配调用 |
| 换核实现 | 替换 `impls/kernels/` 对应文件（Interpreter 接口不变） |
| 新核 | 扩展机制（toolstore ext.kernel）或新增 impls/kernels 文件 + 装配 |

## 迁移历史

1. `2b70c45` 分层①——worker 谱系 → impls/roles（worker-cluster 248 行）
2. `d980c83` 分层②——内置空间 → impls/spaces（函数式注册——ESM 循环 TDZ 踩坑）
3. `718115e` 分层③——核实现 + 装配 → impls/kernels（git mv 12 文件 + 消费者路径更新）
