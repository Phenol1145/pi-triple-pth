# PTH Sandbox 安全运维手册

> 状态：**v3 P4 对齐（2026-08-22 修订）**——覆盖 P0 基线、persistent `/sessions` 会话宿主、
> 签名 grant、session drain 与 readiness；legacy `/kernel/acquire|execute|reset|snapshot|release|cancel`
> 已标 DEPRECATED（新代码禁止使用，后续清理批删除）。

## 1. 范围与前提

- 适用对象：Docker Compose 四服务生产拓扑（postgres / redis / pi-platform / sandbox）。
- 前提：`SANDBOX_SHARED_SECRET` 与 `PTH_EXECUTION_GRANT_SECRET` 均由 compose `${VAR:?}`
  强校验注入，无默认值；`PTH_MEMORY_BRIDGE_TOKEN` 为含 tenant/space 声明的 Redis Bearer
  token，未配置时记忆桥 fail-closed 503。
- P4 会话语义：engine 的 `SandboxKernel` 全量走 `/sessions*`；create 经私有头
  `x-sandbox-grant`（base64url(JSON) 签名 grant）在会话层盖章 task/tenant 绑定；
  snapshot 只导出状态；reset 仅支持回会话初始（`reset(snapshotId)` = MODE_NOT_SUPPORTED）。
- 回滚铁律：**任何回滚都不得恢复「默认共享密钥 + 公开 memory-bridge」历史行为**。

## 2. 密钥轮换

### 2.1 `SANDBOX_SHARED_SECRET`（sandbox 控制器间认证）

1. 生成新密钥（≥32 字节随机，例如 `openssl rand -hex 32`）。
2. 按 3.2 节 drain 在途执行会话。
3. 更新部署环境的密钥注入（compose `.env` / 部署描述符），旧值只作灰度期备份。
4. 同时重启 `pi-platform` 与 `sandbox`：两者必须同轮换，否则互调 401/503。
5. 验证：`docker compose exec sandbox curl -sf http://localhost:8080/health`、
   `/kernel/status` 用新密钥返回 200；旧密钥调用必须 401。

### 2.2 `PTH_MEMORY_BRIDGE_TOKEN`（记忆桥上游 Bearer token）

1. 在 Redis 侧签发/轮换含 tenant/space 声明的 token；**先发后收**（新旧并存）。
2. 更新 `pi-platform` 与 `sandbox` 两个服务的 `PTH_MEMORY_BRIDGE_TOKEN` 并重启。
3. 验证 fail-closed：`docker compose exec sandbox curl -s -X POST localhost:8080/kernel/memory-bridge -d '{"op":"get","id":"x"}'`（无上游 token 时应 503；有 token 时按可见性返回或 404）。
4. 撤销旧 token 前确认两服务均已离开旧值（config 中 grep 零残留）。

### 2.3 `PTH_EXECUTION_GRANT_SECRET`（执行 grant 签名密钥）

1. 生成新密钥（≥32 字节随机，与 `SANDBOX_SHARED_SECRET` 可同值但建议分开管理）。
2. 按 3.2 节 drain 在途会话（旧密钥签发的 grant 在 deadline 内仍有效）。
3. 更新 `.env` / 部署描述符，**pi-platform 与 sandbox 必须同值**；同时重启两服务。
4. 验证：`docker compose exec pi-platform sh -c '...'` 检查两侧 env 一致后，经 engine 提交一个
   python 任务验证 `/sessions` 链路 200；旧密钥签发的 grant 应 401 `signature invalid`。
5. 旧 grant 的 deadline（会话默认 lease 10min）到期前保持新旧密钥并存窗口与 drain 窗口
   一致；到期后即可移除旧值备份。

## 3. 控制器健康与 session-drain

### 3.1 健康视图（当前态）

| 端点 | 语义 |
|---|---|
| `GET sandbox:8080/health` | liveness（无条件 200） |
| `GET sandbox:8080/ready` | readiness：shared-secret / execution-grant-verifier / kernel-pools 三项检查 |
| `GET sandbox:8080/capabilities` | execution/v1.1 能力位图（P4：modes.persistent=true） |
| `GET sandbox:8080/kernel/status`（Bearer 共享密钥） | python/bash 池 + 编译统计 + gdb 会话 + **degraded/reasons**（S1-5；legacy 路由保留至清理批） |
| `GET pi-platform:3000/api/v1/kernel/status` | 全景（含 sandbox 状态聚合） |
| PTH 侧 degraded 监控 | sandbox 后端连续失败阈值 → `/health` 503 + 审计事件 |

sandbox 侧 degraded 信号：`shared-secret-missing` / `bridge-token-missing` /
`pool-exhausted-<lang>` / `compiled-concurrency-saturated`——任一置位即 degraded，
状态跃迁日志事件 `sandbox_health_state_changed`。

排障顺序：先看 `/kernel/status` 池容量与会话占池，再看 pi-platform 日志中
`sandbox_degraded_enter/exit` 审计事件。

### 3.2 session-drain 步骤（重启 sandbox 前）

1. 停止向 sandbox 派发新任务（暂停 batch / 关 worker）。
2. 观察 `/kernel/status` 池占用归零；正常 dispose 会 `release` 会话（幂等，重试安全）。
3. 剩余 active 会话等待 lease 到期（`leaseMs` 5s..24h，缺省 10min；每次 execute 自动续租）
   或逐个 release；**到期/释放后会话进入 expired/released 终态并归还池条目，绝不乐观复用**。
   （engine abort 的会话：本地立即作废、**不 release**，由池 TTL 兜底回收。）
4. 确认无在途后重启；重启完成先 `/health` 再 `/kernel/status`。

## 4. 撤销与重放响应

- 共享密钥泄露 → 立即执行 2.1 全量轮换；轮换前旧会话仍可能被持有旧密钥者使用，
  因此轮换后**不要保留旧密钥的灰度窗口超过 drain 时间**。
- 签名 grant 泄露 → 轮换 2.3 的 `PTH_EXECUTION_GRANT_SECRET`；旧密钥签发的 grant 在
  deadline 内仍有效，因此轮换期间保持 drain 窗口并监控 `signature invalid` 拒绝计数。
- 单个会话/lease 泄露或重放 → 会话在 lease TTL 内失效；重放 execute/reset/snapshot/release
  均被会话状态机与 grant 校验拒绝（released/expired 即不可复用）。必要时重启 sandbox 清空全部池。
- abort 语义（P4）：abort → 本地会话作废、**不主动 release**，池条目由 TTL 兜底回收；
  **正常 dispose 才 release**。不得依赖旧「cancel-ack-release」描述——该语义已随 P4 废弃。
- 记忆桥 body 自报 `space` 一律 400；上游只认 token 声明或 grant，重放无额外授权面。

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
- 审计事件：`sandbox_degraded_enter/exit`、session/grant 授权相关日志
- `/kernel/status` 快照（池容量/会话占池/编译统计/gdb 会话）
- 任务 transcript 与 scorecard（PG `transcripts` 表）

禁止采集/落盘：

- 签名 grant 明文、`SANDBOX_SHARED_SECRET` / `PTH_MEMORY_BRIDGE_TOKEN` /
  `PTH_EXECUTION_GRANT_SECRET` 值
- 任务源代码全文、原始工作区绝对路径（记租户/任务 id 即可）

## 7. 安全回滚

1. 回滚只允许在隔离开发环境选择旧镜像；生产回滚必须新密钥 + 全量 drain。
2. 回滚前截图当前 `/kernel/status` 与 secrets 注入位置。
3. 回滚后必检：compose `config` 中 `SANDBOX_SHARED_SECRET` / `PTH_EXECUTION_GRANT_SECRET`
   仍是 `${VAR:?}` 无默认值；memory-bridge 仍有 Bearer 鉴权且 body.space 被剥除；
   workload env 仍为 allowlist。
4. 任何回滚计划若会恢复共享密钥直通或公开 memory-bridge，**一律拒绝执行**。

## 8. 当前边界与后续收口

- **会话级绑定已实现（P4，2026-08-22）**：create 时经 `x-sandbox-grant` 盖章
  task/tenant/language 绑定；snapshot 只导出状态；reset(snapshotId) 不支持。
- **legacy 清理待办**：`/kernel/acquire|execute|reset|snapshot|release|cancel` 已标
  DEPRECATED，连同旧 private-lease 测试在后续清理批删除。
- **sandbox 宿主收口**：`/exec` 与 `/sessions` 当前为 Fastify 手写实现（与 shared wire
  对齐）；后续迁移到 `ExecutionHttpServer` 统一服务端。
- hostile matrix：矩阵 1/3/4 与 grant 负向已入 `sandbox-security.integration.test.ts`
  （`PTH_SANDBOX_INTEGRATION=1` 门控）；剩余矩阵与 /sessions 负向随 legacy 清理批补齐。
- 其余长尾：`packages/pth-sandbox/TODO.md` 为唯一账本。
