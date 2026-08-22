# FRACTA engine：执行面全部外部化

**Status**: accepted

> **Follow-up（2026-08-22）**：decision 1 的 “dev 容器（dev-container）” 已由 ADR-0002
> 重定位为 tool containers（profile `dev-container`，域 = compiled/network/secrets），
> 本地执行器归 PTH 仓（`pth local-exec` + `pth services`），并新增 jupyter 双面执行面
> （profile `host`）。本 ADR 其余内容保持决策时态。

**Context**：engine（platform 容器）曾内嵌工具链与执行实现（本地 spawn / sandbox 转发 / Lean）。2026-08-21 约定 `platform = FRACTA engine（engine）`：engine 只负责 worker 实现与面向 LLM 的 interface；所有执行面放在外部实现，经 `execution/v1` 以 engine 为协议中心连接。

## Decision

1. engine 是 `execution/v1` 的唯一协议客户端；外部执行面 = sandbox 容器（`sandbox-untrusted`）、dev 容器（`dev-container`）、本地执行器（`host`）。
2. 网络保持现状：sandbox 保留 `sandbox-internal` 的 egress 锁，engine 双网接入；dev 容器 / 本地执行器经 default 网络可达 engine（本地执行器为 `host.docker.internal`）。
3. Lean 移出 engine 容器，放宿主机本地执行器，经 `execution/v1` 与 engine 连接。
4. 优先固定协议面，再做实现迁移。
5. 命名：代码名、包名、compose 服务名暂仍为 PTH / pi-platform；文档术语统一为 engine / FRACTA engine，品牌重命名单独立项。

## Why

执行面外部化把「解释什么（engine：worker + LLM interface）」与「怎么执行（外部执行面：spawn / 工具链 / 沙箱）」彻底分离；`execution/v1` 的 profile 模型（`host` / `dev-container` / `sandbox-untrusted`）恰好表达三类执行面。先固定协议面，避免每新增一个执行器就引入一种新 wire。

## Considered Options

- **全部执行面并入 default 网络**：否决——sandbox 的 egress 锁是安全不变量，不能用统一网络破坏它。
- **Lean 放 dev 容器**：备选，暂缓——先落宿主机本地执行器（镜像最小、迁移最快），dev 容器后续复用同一实现成为第二个 `dev-container` 执行面。
- **立即重命名代码 / 服务名**：否决——品牌迁移独立立项；避免 `PLATFORM_URL`、监控、脚本全链路回归。

## Consequences

- `deploy/Dockerfile` 需移除 elan / lean / lake；Lean 运行时适配器从「容器内 spawn」改为「`HttpExecutionClient` 指向本地执行器」。
- dev 容器当前没有 `/exec` HTTP 面，要成为 engine 执行面需补一个 `execution/v1` server。
- 后续协议面固定步骤见 `docs/fracta-engine-execution-topology.md`（三仓同源）。
