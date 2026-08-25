# PTH 分层架构

> PTH = 自耦自然语言解释器（解释即执行）。本页是 PTH 内部分层的**薄索引**；
> 模块边界、公共端口、依赖矩阵与生命周期不变量见 **[framework-contracts.md](framework-contracts.md)**。
> 与 PTL 的关系见 `docs/ptl/architecture.md`（PTL 仓）。

## 分层原则

> 尽可能把 PTH 分解开：**可独立发布的内核域能力放 `packages/pth-*`，产品组装层与运行宿主放 `src/pth`，CLI 入口放 `src/cli`。**

- **内核域包（`packages/pth-*`）**：可被多个宿主（API host、batch worker、CLI、console）复用的领域逻辑。
- **应用/组装层（`src/pth/`）**：产品装配、HTTP/gateway、任务调度、进程生命周期、环境接线。
- **CLI 入口（`src/cli/`）**：`pth` 命令入口、runtime 检测/doctor/orchestrator/local-process。

```
packages/pth-contracts ──► packages/pth-{config,memory,kernel-*}
        ▲                        │
        │                        ▼
src/pth/{tasking,runner,interaction,execution,catalog,...} ──► bootstrap ──► main / batch-process
        ▲
src/cli ┘
```

## 模块速查（`src/pth/`）

| 目录 | 角色 |
|---|---|
| `src/pth/gateway/` | HTTP 层：任务/kernel/jobs/events/sessions 路由 |
| `src/pth/application/` | 应用层：operator console、观测 facade、系统检查 |
| `src/pth/runner/` | 任务执行装配：exec-modes（tool-call/asp/ptc/pulse）、agent-task-runner |
| `src/pth/tasking/` | 任务池：claim/run/commit、delegation、penetration、side-effect outbox |
| `src/pth/interaction/` | Human Interaction：intent-resolver、task-draft、presentation |
| `src/pth/kernel/` | 内核根：assembly（组合根）、兼容门面 |
| `src/pth/bootstrap/` | 装配/启动：pth-host、batch-process、task-loop、worker-slot |
| `src/pth/catalog/` | 运行时目录：角色、学科、数据、扩展装载 |
| `src/pth/impls/` | 具体实现：kernels（ts-interpreter/capability）、roles |
| `src/pth/observability/` | 可观测：metrics、resource-provider、runtime observatory |
| `src/pth/services/` | 常驻服务接线 |
| `src/pth/shared/` | 应用共享工具（pg-queryable 等） |
| `src/pth/tools/` | 工具面：tool 注册与执行 |
| `src/pth/bench/` | PTH Bench 装配与驱动 |
| `src/pth/core/` | 独立维护模块（AgentEngine 等） |
| `src/pth/components/` | 组件层 |
| `src/pth/fallback/` | 兼容/降级路径 |
| `src/pth/programs/` | program 执行面 |
| `src/pth/prototypes/` | 冻结原型（workflow 等） |
| `src/pth/self-modify/` | 自修改指南与不变量 |

## 包速查（`packages/pth-*`）

| 包 | 角色 |
|---|---|
| `pth-contracts` | 契约包：类型、结构校验、协议冻结 |
| `pth-config` | 配置包：`PTH_*` 键与默认值 |
| `pth-memory` | 记忆域：memory 存储、用途层策略、空间可见性、索引、治理执行、skill 格式 |
| `pth-sandbox` | 沙箱域：内核契约、持久内核运行时、编译核、gdb、沙箱客户端与宿主 |
| `pth-kernel-storage` | 持久化基座：PG 数据世界 + Redis 会话平面 |
| `pth-kernel-interpreter` | 解释器：ts 核（PTC vm）、llm-fn、toolstore、exec-channel |
| `pth-kernel-execution` | 内核执行：execution、logger、prompt-docs、exec-channel、agent-loop |
| `pth-console` | console/client/protocol/web：pth CLI 命令 + 人类操作台 |
| `pth-cli` | pth CLI 打包壳：dist + deploy/ 拷贝，无 src |

## 机器强制边界

`npm run check:pth-boundaries`（已并入 `npm run lint`）强制：
- `src/` → `packages/` 单向依赖，`packages/` 不得回指 `src/`。
- gateway 不碰 kernel 内部；跨模块只走公共 `index.ts`。
- sandbox 运行时 adapter 仅白名单目录。
- contracts 纯度；新增违规 CI 失败。

另由 `check:product-boundaries` 强制 PTH/PTL 产品边界，`check:import-cycles` 强制无循环。

## 替换 / 扩展点

| 目标 | 替换方式 |
|---|---|
| 换内置角色谱系 | 替换 `src/pth/impls/roles/` 或注册扩展角色 |
| 无内置空间发行版 | 移除装配调用 + 改 catalog manifest |
| 换核实现 | 替换 `src/pth/impls/kernels/` 对应文件（`Interpreter` 契约不变） |
| 换 tasking/execution 宿主 | 实现 `packages/pth-contracts` 端口并在 `src/pth/bootstrap/pth-host.ts` 接线 |

## 历史

本页早期描述「core + impls」两分层；2026-08-16 模块化 v2 后细化为八模块 + 两个 package；
2026-08-25 仓库结构诊断后按 9 包 + `src/pth` 现实目录重写。
