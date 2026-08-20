# 容器运行时适配器协议（v1 核心，R1–R3）

> 状态：2026-08-21 实施中。本文当前覆盖 **R1 接口契约 / R2 选择协议 / R3 lock**；
> R4 Docker/OrbStack 数据适配器、R5 Podman 适配器、R6 /health 暴露在后续 lane 完成。
> 代码权威实现：`packages/infra/src/container-runtime/*`。

## 1. 目标

把「本机容器运行时」（Docker / OrbStack / Podman）抽象成一个**只读**适配器契约：

- 监控台（docker-monitor）与 PTL 容器运维都只面对统一接口，不再各自拼 socket/命令；
- 选择运行时只允许：显式 env 优先 → lock 白名单 socket 自动 probe → 多可用 fail-closed；
- `container-runtime-lock.json` 是允许运行时、版本约束与 probe 定义的唯一事实源。

安全边界：本协议只有 `GET` 探测与只读数据面；不提供 create/start/stop/exec 等写能力。写能力继续由 PTL 容器后端（framework/containers）负责，不混入本协议。

## 2. R1 接口契约

每个 `ContainerRuntimeAdapter` 暴露五个成员 + 三个只读方法：

```ts
interface ContainerRuntimeAdapter {
  readonly id: ContainerRuntimeId;                 // docker | orbstack | podman
  readonly socket: string;                          // lock 白名单展开后的绝对路径
  probe(): Promise<ContainerRuntimeProbe>;          // {available, reason?}；不抛异常
  version(): Promise<ContainerRuntimeVersion>;      // {id, version, apiVersion?}
  readonly features: ContainerRuntimeFeatures;      // 附加能力位（events/health）
  listContainers(): Promise<ContainerRuntimeSummary[]>;
  inspectContainer(id: string): Promise<ContainerRuntimeInspect>;
  getContainerStats(id: string): Promise<ContainerRuntimeStats>;
}
```

- `probe()` 只回答“当前 socket 是否可用”；不可用时必须给稳定 `reason`（ENOENT/状态码/超时），不向上抛原始 socket 响应。
- `version()` 返回引擎语义化版本；`id` 必须与适配器 `id` 一致。
- 三个只读方法的数据形状是**归一化**的：
  - `listContainers`：id/names/image/state/status/health；
  - `inspectContainer`：id/name/image/createdAt/startedAt/finishedAt/running/exitCode（epoch ms，未知为 null）；
  - `getContainerStats`：单帧累计计数器（cpu.totalUsage/systemUsage/onlineCpus、memory usage/limit、network rx/tx）。**百分比由调用方两帧差计算**，与现网 docker-monitor 口径一致。
- 实现不得在这三个方法里触发任何容器写操作。

## 3. R2 选择协议

### 3.1 环境变量

| 变量 | 含义 |
|---|---|
| `PI_CONTAINER_RUNTIME` | 显式指定 runtime id；设置了就**优先且不回退** |
| `PI_CONTAINER_RUNTIME_SOCKET` | 可选显式 socket；必须命中 lock 中该 runtime 的白名单，否则 `SOCKET_NOT_ALLOWED` |

### 3.2 算法

1. 读 `deploy/container-runtime-lock.json`，只保留 `allowed: true` 的 runtime；
2. 展开各 runtime 的 socket 模板（`${HOME}` / `${XDG_RUNTIME_DIR}` / `${UID}`，缺失则跳过该候选）；
3. **显式路径**：若设置了 `PI_CONTAINER_RUNTIME`：
   - 未声明或 `allowed:false` → `RUNTIME_NOT_ALLOWED`；
   - 显式 socket 不在白名单 → `SOCKET_NOT_ALLOWED`；
   - 对候选执行 `probe → version → 版本约束`，任一失败 → `EXPLICIT_RUNTIME_UNAVAILABLE`；不自动尝试其他 runtime；
   - 同一 id 有多个 socket 时按 lock 顺序取第一个可用。
4. **自动路径**：按 lock 顺序逐个 probe：
   - 恰好 1 个候选通过 → 选中，`source: "probe"`；
   - 0 个通过 → `NO_RUNTIME_AVAILABLE`，错误携带每个 socket 的 reason；
   - >1 个通过 → `AMBIGUOUS_RUNTIME`（fail-closed），错误信息提示设置 `PI_CONTAINER_RUNTIME`。

选择结果 `ContainerRuntimeSelection = { id, socket, version, source: "env" | "probe", probed }`。
R4/R5 适配器工厂接收该结果，再装配完整 `ContainerRuntimeAdapter`。

## 4. R3 container-runtime-lock.json

位置：`deploy/container-runtime-lock.json`。Schema：

```jsonc
{
  "version": 1,
  "runtimes": [{
    "id": "docker",                      // docker | orbstack | podman
    "allowed": true,
    "versionConstraint": ">=20.10.0",    // * | >=x.y.z | >x.y.z | <=x.y.z | <x.y.z | =x.y.z
    "sockets": ["/var/run/docker.sock"], // 绝对路径或 ${HOME|XDG_RUNTIME_DIR|UID} 模板
    "probe": {
      "method": "GET",                   // 只允许 GET
      "path": "/_ping",
      "successStatus": [200],
      "timeoutMs": 2000
    },
    "version": {
      "method": "GET",
      "path": "/version",
      "field": "Version",                // 点路径（如 Client.Version）
      "timeoutMs": 2000
    }
  }]
}
```

校验规则（解析时 fail-closed）：

- `version` 必须为 1；runtime id 必须登记且不重复；`allowed` 必须为 boolean；
- socket 只允许绝对路径或白名单占位符模板，拒绝相对路径/未知 `${...}`；
- 版本约束只允许显式操作符（不支持 `~`/`^` 范围语法）；probe/version 只允许 GET；
- `timeoutMs` 必须在 100–60000。

当前提交的 lock 基线：docker `>=20.10.0`、orbstack `>=1.0.0`、podman `>=4.0.0`。

## 5. 测试与后续

- 契约测试：`packages/infra/test/container-runtime-*.test.ts`（R1 假适配器契约、R2 选择矩阵、R3 lock 校验、unix socket 探测）。
- 待办：R4 用契约改造 `deploy/docker-monitor/docker-api.js` 为 Docker/OrbStack 数据适配器；R5 Podman 适配器跑同一 contract；R6 `/health` 暴露 runtime id/version/socket/采集能力；R8 权威验收。
