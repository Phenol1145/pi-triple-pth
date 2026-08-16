# PTH Sandbox 安全运维手册

> 状态：**当前态草稿（2026-08-16）**——覆盖已落地的 P0 安全基线与 lease 协议。
> v2 P2（grant 化 / cancel-ack-release / readiness）落地后必须按 S2-5 收账修订：
> 认证模型会从共享密钥升级为签名 grant，本手册的相关章节需同步改写。

## 1. 范围与前提

- 适用对象：Docker Compose 四服务生产拓扑（postgres / redis / pi-platform / sandbox）。
- 前提：`SANDBOX_SHARED_SECRET` 由 compose `${VAR:?}` 强校验注入，无默认值；
  `PTH_MEMORY_BRIDGE_TOKEN` 为含 tenant/space 声明的 Redis Bearer token，未配置时记忆桥 fail-closed 503。
- 回滚铁律：**任何回滚都不得恢复「默认共享密钥 + 公开 memory-bridge」历史行为**。

## 2. 密钥轮换

### 2.1 `SANDBOX_SHARED_SECRET`（sandbox 控制器间认证）

1. 生成新密钥（≥32 字节随机，例如 `openssl rand -hex 32`）。
2. 按 3.2 节 drain 在途 kernel lease。
3. 更新部署环境的密钥注入（compose `.env` / 部署描述符），旧值只作灰度期备份。
4. 同时重启 `pi-platform` 与 `sandbox`：两者必须同轮换，否则互调 401/503。
5. 验证：`docker compose exec sandbox curl -sf http://localhost:8080/health`、
   `/kernel/status` 用新密钥返回 200；旧密钥调用必须 401。

### 2.2 `PTH_MEMORY_BRIDGE_TOKEN`（记忆桥上游 Bearer token）

1. 在 Redis 侧签发/轮换含 tenant/space 声明的 token；**先发后收**（新旧并存）。
2. 更新 `pi-platform` 与 `sandbox` 两个服务的 `PTH_MEMORY_BRIDGE_TOKEN` 并重启。
3. 验证 fail-closed：`docker compose exec sandbox curl -s -X POST localhost:8080/kernel/memory-bridge -d '{"op":"get","id":"x"}'`（无上游 token 时应 503；有 token 时按可见性返回或 404）。
4. 撤销旧 token 前确认两服务均已离开旧值（config 中 grep 零残留）。

## 3. 控制器健康与 lease-drain

### 3.1 健康视图（当前态）

| 端点 | 语义 |
|---|---|
| `GET sandbox:8080/health` | liveness（当前无条件 200；readiness 拆分在 v2 P2-6） |
| `GET sandbox:8080/kernel/status`（Bearer 共享密钥） | python/bash 池 `inFlight/idle/size/capacity`、编译统计、gdb 会话数 |
| `GET pi-platform:3000/api/v1/kernel/status` | 全景（含 sandbox 状态聚合） |
| PTH 侧 degraded 监控 | `sandbox-bash.ts` 连续失败阈值 → `routes-self /health` 503 + 审计事件 |

排障顺序：先看 `/kernel/status` 池容量与 acquire 排队，再看 pi-platform 日志中
`sandbox_degraded_enter/exit` 审计事件。

### 3.2 lease-drain 步骤（重启 sandbox 前）

1. 停止向 sandbox 派发新任务（暂停 batch / 关 worker）。
2. 观察 `/kernel/status` 的 `inFlight` 归零；`release` 幂等，客户端重试安全。
3. 剩余 active lease 等待 TTL（`PTH_KERNEL_ENTRY_TTL_MS`）或逐个 release；
   **TTL 到期是 `active → cancelling → disposed` 并移出池，绝不复用旧 lease**。
4. 确认无在途后重启；重启完成先 `/health` 再 `/kernel/status`。

## 4. 撤销与重放响应

- 共享密钥泄露 → 立即执行 2.1 全量轮换；轮换前旧 lease 仍可能被持有旧密钥者使用，
  因此轮换后**不要保留旧密钥的灰度窗口超过 drain 时间**。
- 单个 lease 泄露/重放 → 该 lease 已在 TTL 内失效；重放旧 lease 的
  execute/reset/snapshot/release 均被 `generation` 校验拒绝。必要时重启 sandbox 清空全部池。
- 记忆桥 body 自报 `space` 一律 400；上游只认 token 声明，重放无额外授权面。

## 5. 工作区与缓存清理

- 租户工作区：`/data/workspaces/<tenant>/...` 0700，workload UID 2001 不能读其他租户。
- `/exec` 私有工作区：生产 `PTH_EXEC_PRIVATE_ROOT=/srv/workload`，进/出回拷；
  异常退出残留可用 `docker compose exec sandbox find /srv/workload -maxdepth 2 -type d` 排查后手工清理。
- 编译缓存：`PTH_COMPILED_CACHE_DIR`，上限 `PTH_COMPILED_CACHE_MAX_MB`（默认 200MB）+
  `PTH_COMPILED_MAX_CACHE`（默认 50 条），超限自动删最旧；一般无需手工清理。
- gdb 工作区：`.debug/<sessionId>` 在 detach/idle 回收后清理；若进程崩溃残留，
  按 `/kernel/debug/sessions` 对照删除孤儿目录。

## 6. 事故证据采集

必须采集：

- pi-platform / sandbox 两容器日志（`LOG_LEVEL=info`；必要时临时 `debug` 后恢复）
- 审计事件：`sandbox_degraded_enter/exit`、lease/授权相关日志
- `/kernel/status` 快照（池容量/inFlight/编译统计/gdb 会话）
- 任务 transcript 与 scorecard（PG `transcripts` 表）

禁止采集/落盘：

- 签名 grant 明文（v2 P2 落地后）、`SANDBOX_SHARED_SECRET` / `PTH_MEMORY_BRIDGE_TOKEN` 值
- 任务源代码全文、原始工作区绝对路径（记租户/任务 id 即可）

## 7. 安全回滚

1. 回滚只允许在隔离开发环境选择旧镜像；生产回滚必须新密钥 + 全量 drain。
2. 回滚前截图当前 `/kernel/status` 与 secrets 注入位置。
3. 回滚后必检：compose `config` 中 `SANDBOX_SHARED_SECRET` 仍是 `${VAR:?}` 无默认值；
   memory-bridge 仍有 Bearer 鉴权且 body.space 被剥除；workload env 仍为 allowlist。
4. 任何回滚计划若会恢复共享密钥直通或公开 memory-bridge，**一律拒绝执行**。

## 8. 待 v2 P2 落地后的修订点（S2-5 收账时执行）

- 2.1/2.2 增加签名 grant 的签发/验证/轮换（`ExecutionGrantService`）
- 3.2 增加 cancel-ack-release 状态机与 transport deadline 运维视图
- 3.1 替换为 liveness/readiness 拆分后的健康矩阵
- 4 增加 grant 过期/重放/撤销的精确响应表
