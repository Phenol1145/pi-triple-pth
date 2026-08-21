# 执行面统一协议设计（execution/v1）

> 状态：已批准（2026-08-21）· 路线 P0→P3 分阶段执行
> 三仓同源：`pi-triple-deps` / `pi-triple-pth` / `pi-triple-ptl` 必须同步本文件。

## 1. 问题

当前“执行一条命令”有三套互不相通的实现：

1. **pth-sandbox `/exec`**：HTTP + SSE，cwd 白名单、UID 降权、egress 锁、超时/输出上限——但类型只存在于 pth-sandbox 包内。
2. **PTH professional adapters**（lean4 / assembly / chemistry / wolfram / jupyter）：每个 adapter 各自实现 `execPrefix` / `exec` 注入，spawn 与 `docker exec` 分支重复四遍，路径翻译是 ad hoc。
3. **PTL 本地工具**（`dev-container`、`ptl stack`、program-dev）：`docker compose exec dev bash -lc`、`spawnSync`，没有统一的结果结构，也没有流式/取消语义。

目标：**一套执行面协议 + 一个接口，承载宿主、dev 容器、不可信 sandbox 三类执行**；
信任差异用显式 `profile` 表达，不用协议形状掩盖安全边界。

## 2. 非目标

- 不替代容器生命周期管理（deploy/up/down/logs 仍属 `ContainerBackend`）。
- 不替代 container-runtime 选择（R1–R3：Docker/OrbStack/Podman probe/lock）。
- 不在本协议内做任务调度/资源配额（那是上层 batch/kernel 的职责）。
- 不做“跨主机透明执行”——每台机器的执行必须落在明确声明的 backend。

## 3. 协议定义

### 3.1 请求 `ExecutionRequest`

```ts
interface ExecutionRequest {
  /** shell 字符串（backend 自行决定 shell 语义）或 argv 数组（不经 shell） */
  cmd: string | string[];
  /** 执行目录；backend 校验策略由 profile 决定 */
  cwd?: string;
  /** env 增量；sandbox-untrusted 默认拒绝敏感键，见 §6 */
  env?: Record<string, string>;
  /** 超时 ms（>0）；到达后 backend 必须终止整个进程组 */
  timeoutMs?: number;
  /** stdout/stderr 字节上限（1..4MB）；超限终止进程组并回 truncated */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** true → 返回 execId 异步执行，经流式接口消费 */
  stream?: boolean;
  /** 宿主路径 ↔ 执行端路径映射（docker exec / jupyter 已证明必要；一等字段） */
  pathMapping?: { hostRoot: string; execRoot: string };
  /** 信任档：host | dev-container | sandbox-untrusted */
  profile?: ExecutionProfile;
}
```

### 3.2 结果 `ExecutionResult`

```ts
interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  truncated?: { field: "stdout" | "stderr"; originalLen: number; keptLen: number };
  /** stream 完成态附带 */
  execId?: string;
}
```

### 3.3 流式接口

以 sandbox 已验证的 HTTP/SSE 形状为准：

- `POST /exec`：同步执行返回 `ExecutionResult`；`stream:true` 返回 `{ execId, status:"running" }`
- `GET /exec/:id`：`{ status:"running"|"done", result? }`
- `GET /exec/:id/stream`：SSE `event: output {stream,data}` + `event: done {exitCode,timedOut}`；完成态可重放
- `POST /exec/:id/cancel`：终止进程组（backend 能力允许时）

### 3.4 能力声明 `ExecutionBackend.capabilities`

```ts
interface ExecutionCapabilities {
  streaming: boolean;      // 是否支持 execId + SSE
  cancel: boolean;         // 是否支持取消
  cwdWhitelist: boolean;   // cwd 是否白名单约束
  uidIsolation: boolean;   // 是否以独立 UID 执行
  egressLocked: boolean;   // 是否无出网
  pathMapping: boolean;    // 是否支持路径翻译
}
```

## 4. 接口与实现归属

| 层 | 归属仓 | 内容 |
|----|--------|------|
| 类型 + 校验 + client | `pi-triple-deps`（`@away_from/shared`） | `ExecutionRequest/Result`、`validateExecutionRequest`、`ExecutionClient` |
| `SandboxBackend` | `pi-triple-pth`（pth-sandbox） | 现有 `/exec` 对齐 execution/v1，`profile=sandbox-untrusted` |
| `LocalBackend` | `pi-triple-ptl` | 宿主 `spawn`，`profile=host` |
| `DockerExecBackend` | `pi-triple-ptl` | `docker compose exec -T` / `docker exec`，`profile=dev-container` |
| 调用方迁移 | PTH / PTL | professional adapters、bash/py kernel、dev-container verify |

## 5. 执行路线（每阶段独立门禁）

### P0：契约冻结（deps）
- shared 新增 `src/execution/`：类型、`validateExecutionRequest`、wire 常量（`/exec`、SSE 事件名）。
- golden 契约测试：sandbox 当前实现的合法/非法 payload 逐字段锁定。
- 验收：deps `lint/build/test` 全绿；类型三仓可 import。

### P1：sandbox 对齐（pth）
- `pth-sandbox/src/exec-api*` 改为 import shared 类型与校验（行为零变化）。
- 新增 `/exec/:id/cancel`（当前只有超时/限额强杀）。
- `/capabilities` 暴露能力声明。
- 验收：sandbox 全部既有测试 + 契约测试全绿；`pth up` 栈回归。

### P2：PTL 本地 backend（ptl）
- 新增 `packages/framework/src/execution/`：`LocalBackend`、`DockerExecBackend`、client。
- `dev-container verify`、`ptl stack exec` 改走 `ExecutionBackend`。
- 验收：PTL 464 tests 全绿 + dev-container 命令冒烟。

### P3：PTH 调用方迁移（pth）
- 四个 professional adapters 与 bash/py kernel 改走 `ExecutionClient`/`ExecutionBackend`，
  删除各自 `execPrefix` 重复实现（保留构造参数兼容一个版本后移除）。
- 验收：professional 垂直测试 + PTH full 全绿。

## 6. 安全不变量

1. `profile` 只能由 backend 选择或声明为 `sandbox-untrusted` 的服务端降级，客户端不得自我提升。
2. `sandbox-untrusted` 保持：shared-secret 认证、cwd 白名单、UID 2001 降权、私有工作区回拷、egress 锁、env 敏感键拒绝（LLM 密钥等）。
3. `host` / `dev-container` 仍做：argv 无 shell 拼接、超时/输出上限、路径映射防穿越（`..`、绝对路径逃逸拒绝）。
4. 协议错误一律结构化返回（`{ error: { code, message } }`），不抛裸错误；取消是尽力而为语义。

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| 统一协议掩盖信任差异 | `capabilities` + `profile` 显式声明；客户端按能力降级 |
| sandbox 行为漂移 | shared golden 契约测试在 P0 冻结，P1 反向对齐 |
| docker exec 无可靠流式/取消 | `DockerExecBackend` 以 `docker exec` 短命令 + 轮询输出文件起步；能力声明 `streaming:false`，不假装支持 |
| 路径翻译出错 | `pathMapping` 一等字段 + hostRoot/execRoot 双端校验 |
| 版本漂移 | wire 常量 `execution/v1`；breaking 升级走 v2 与 backend `capabilities.version` |

## 8. 决策记录

- 协议类型放 `@away_from/shared`（跨产品协议层，符合三仓定位矩阵）。
- wire 层复用 sandbox HTTP/SSE（不发明新传输）。
- `ptl stack` 的部署生命周期不并入本协议（保留 `ContainerBackend`）。
