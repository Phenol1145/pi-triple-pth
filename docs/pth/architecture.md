# PTH 分层架构

> PTH = 自耦自然语言解释器（解释即执行）。本页是 PTH 内部分层的**薄索引**；
> 模块边界、公共端口、依赖矩阵与生命周期不变量见 **[framework-contracts.md](framework-contracts.md)**。
> 与 PTL 的关系见 `docs/ptl/architecture.md`。

## 分层原则

> "尽可能把 PTH 分解开——所有核和 worker 谱系都作为一个具体实现提供。"

- **框架层**：`contracts / tasking / runner / execution / catalog / bootstrap` ——机制、端口、策略。
- **实现层**：各 `adapters/`、`impls/`、`application/gateway`、`gateway/`、`packages/pth-sandbox`、`packages/pth-memory` ——具体技术宿主（PG/Fastify/sandbox HTTP/内核进程）。
- **组合根**：`bootstrap/pth-host.ts` ——唯一把框架端口接到具体实现的装配点；
  `main.ts`（API Host）与 `batch-process.ts`（runner Host）共用同一 manifest/catalog。

```
contracts ──► tasking/runner/execution ──► bootstrap ──► main / batch-process
                    ▲
catalog ────────────┘
gateway ──► application/pth-gateway-facade ──► kernel（唯一窄口）
```

## 模块速查

| 目录 | 角色 |
|---|---|
| `src/pth/contracts/` | 纯类型 + 结构校验（零宿主依赖） |
| `src/pth/tasking/` + `adapters/` | 任务 claim/run/commit、CAS、observers（PG 实现） |
| `src/pth/runner/` + `observers/` | 纯执行 + post-commit 副作用 |
| `src/pth/execution/` + `authorization/adapters/` | grant 签发/校验、ExecutionPort、KnowledgeBroker |
| `src/pth/catalog/` + `adapters/extensions/` | 不可变运行时目录、路由/空间策略、扩展贡献 |
| `src/pth/bootstrap/` | 统一装配（fail-closed） |
| `src/pth/gateway/` / `src/pth/application/gateway/` | HTTP 层 + 唯一 kernel facade |
| `src/pth/kernel/` | 存量核心引擎（逐批收口中） |
| `src/pth/impls/` | 具体实现：核 / 角色 / 空间 |
| `packages/pth-sandbox` | 沙箱域 + 内核 interpreter 契约 |
| `packages/pth-memory` | 记忆域 |

## 机器强制边界

`npm run check:pth-boundaries`（已并入 `npm run lint`）强制：
gateway 不碰 kernel 内部；跨模块只走公共 `index.ts`；sandbox 运行时 adapter 仅白名单目录；
contracts 纯度；新增违规 CI 失败。

## 替换 / 扩展点

| 目标 | 替换方式 |
|---|---|
| 换内置角色谱系 | 替换 `impls/roles/default-roles.ts`（或注册扩展角色） |
| 无内置空间发行版 | 移除装配调用 + 改 catalog manifest |
| 换核实现 | 替换 `impls/kernels/` 对应文件（`Interpreter` 契约不变） |
| 换 tasking/execution 宿主 | 实现 `contracts` 端口并在 `bootstrap/pth-host.ts` 接线 |

## 历史

本页曾是「core（kernel/execution·interpreter·extensions）+ impls/」两分层的详细目录图；
2026-08-16 模块化 v2 完成后，细化为上述八模块 + 两个 package，详细契约迁往
`framework-contracts.md`。
