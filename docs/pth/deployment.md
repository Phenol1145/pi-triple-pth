# PTH 安装与性能调优

> 与共享层 skill `pth-deploy` 同源（2026-08-09）。覆盖：compose 拓扑、安装步骤、验证三连、性能参数全表、调优方法论、运行时调参、容器抽象设计意图（v0.7）。


# PTH 安装与性能调优

PTH（Pi-Triple-Heavy）是服务器端任务内核（Fastify 网关 + kernel 任务池 + sandbox 隔离执行）。本文档带你从零安装并用参数压到目标吞吐。

## 1. 拓扑（docker compose 四服务）

```
docker-compose.yaml
├── postgres  16-alpine      任务/记忆/transcripts 存储（DATABASE_URL）
├── redis     7-alpine       auth token 存储（REDIS_URL）
├── pi-platform              PTH 主服务（Fastify :3000——网关 + kernel 装配 + 指标）
│     └── kernel 池：sandbox-kernel 模式（生产默认——REPL kernel 落 sandbox 侧）
└── sandbox                  隔离执行容器（:8080——kernel-host 池 + exec API + 调试工具链）
      · internal 网络（零出口）· 零业务密钥 · Bearer 认证 · 非 root · 资源限额 1G/1cpu
```

两个网络：`default`（平台内部）+ `sandbox-internal`（internal:true——sandbox 唯一出口是 pi-platform）。

## 2. 安装步骤

### 2.1 前置
- Docker + Docker Compose v2（`docker compose version` 确认）
- 仓库 clone：`git clone https://github.com/Phenol1145/pi-platform.git`

### 2.2 配置 .env（仓库根）

```bash
# 安全参数（必改）
POSTGRES_PASSWORD=你的强密码
SANDBOX_SHARED_SECRET=你的沙盒共享密钥

# 性能参数（按需——见 §3 全表）
PTH_KERNEL_POOL_SIZE=16
PTH_BATCH_AUTOSCALE=on
```

### 2.3 拉起（依赖顺序：先数据层，再应用层）

```bash
docker compose up -d postgres redis
# 等 healthy（docker compose ps——postgres 需 ready 后 pi-platform 才能连）
docker compose up -d pi-platform sandbox
docker compose ps          # 四服务都应 healthy
```

### 2.4 验证三连

```bash
# ① 健康与状态
curl -s http://localhost:3000/api/v1/kernel/status -H "Authorization: Bearer <token>" | python3 -m json.tool
#   → kernel.connected:true · tasks 分布 · watchdog 无 crash

# ② 端到端任务（发布 → 完成）
curl -s -X POST http://localhost:3000/api/v1/kernel/tasks \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"title":"install-verify","text":"const r = await python.execute(\"sum(range(101))\"); return { sum5050: r };","createdBy":"ops"}'
#   → 返回 id + pending；~15s 后查 status 应为 completed，结果 sum5050=5050

# ③ 安全确认（sandbox 零敏感）
bash scripts/check-sandbox-env.sh     # 镜像扫描 + 容器 env 白名单断言
```

token 写入 Redis：`redis-cli -h localhost set auth:token:<token> '{"tenantId":"ops"}'`（或按你的 auth 约定）。

## 3. 性能参数全表（PTH_*）

### 硬性资源限制（compose deploy.resources.limits——全服务）

| 服务 | CPU | 内存 | PIDs | 说明 |
|------|-----|------|------|------|
| pi-platform | 2.0 | 2G | 512 | 主进程 + batch 子进程（≤4 batch × 7 worker） |
| sandbox | 1.0 | 1G | 256 | kernel 池 16 python + node（池容量与内存联动：16×40MB≈640MB） |
| postgres | 1.0 | 512M | 128 | 存储 |
| redis | 0.5 | 256M | 64 | auth/缓存（另有 maxmemory 1gb 自限） |

node 堆上限：`NODE_OPTIONS=--max-old-space-size=768`（pi-platform 主进程 + batch 子进程继承——防大 payload OOM 主机）。

### 池容量（最重要——不足会 acquire 排队超时卡任务）

| 参数 | 默认 | 说明 | 调优 |
|------|------|------|------|
| `PTH_KERNEL_POOL_SIZE` | 16 | sandbox kernel 池容量（REPL 持久进程数） | **必须 ≥ 并发 worker 数**（batch×角色，如 2 batch×7 角色=14）→ 设 16 起步；高并发提到 24-32 |

### agent 循环（单任务执行成本）

| 参数 | 默认 | 说明 |
|------|------|------|
| `PTH_AGENT_MAX_STEPS` | 10 | 每任务 agent 步数上限（典型任务 2-3 步即完成） |
| `PTH_AGENT_TIMEOUT_MS` | 120000 | 任务级总超时 |
| `PTH_AGENT_LLM_TIMEOUT_MS` | 30000 | 单次 LLM 调用超时（防挂起冻结——建议保持） |
| `PTH_AGENT_RETRY_PARSE` | 1 | 动作解析失败重试次数 |
| `PTH_AGENT_MODEL` | deepseek-v4-flash | agent 循环模型（选快模型——执行性价比优先） |

### batch 轮询与连接（吞吐/内存）

| 参数 | 默认 | 说明 |
|------|------|------|
| `PTH_BATCH_TICK_MS` | 1000 | 空闲轮询间隔（忙时自驱动——任务完成立即继续认领，零轮询等待） |
| `PTH_PG_POOL_MAX` | 8 | batch 子进程 PG 连接池上限（7 角色并发 ≤7——8 够；总量 = 8 × batch 数） |

### batch 弹性（吞吐自动伸缩）

| 参数 | 默认 | 说明 |
|------|------|------|
| `PTH_BATCH_AUTOSCALE` | on | 弹性开关 |
| `PTH_BATCH_MIN` / `PTH_BATCH_MAX` | 1 / 4 | 容量上下限保护 |
| `PTH_BATCH_SCALE_INTERVAL_MS` | 30000 | 评估周期 |
| `PTH_BATCH_SCALE_UP_THRESHOLD` | 5 | pending 积压阈值（超过则扩容） |

### claim 回收（僵尸任务治理）

| 参数 | 默认 | 说明 |
|------|------|------|
| `PTH_CLAIM_REAP_MS` | 30000 | 回收扫描周期 |
| `PTH_CLAIM_TIMEOUT_MS` | 600000 | 认领超时阈值（超时自动回池重执行） |

### kernel 生命周期

| 参数 | 默认 | 说明 |
|------|------|------|
| `PTH_KERNEL_LAZY_SPAWN` | 1 | 懒 spawn（首次 execute 才起进程——省内存） |
| `PTH_KERNEL_IDLE_MS` | 300000 | 空闲回收（5min 无调用 kill——0=禁用） |
| `PTH_KERNEL_RESET_MODE` | ns | reset 语义（ns=清命名空间 / restart=重启进程） |

### 模式与模型

| 参数 | 默认 | 说明 |
|------|------|------|
| `PTH_PYTHON_MODE` / `PTH_BASH_MODE` | sandbox-kernel | 生产必须 sandbox-kernel（kernel=本地调试） |
| `PTH_MODEL` / `PTH_MODEL_PROVIDER` | - | 全局模型/供应商 |
| `PTH_NL_MODEL` | - | NL 任务翻译模型（可单独指定） |
| `PTH_REFINE` | on | 记忆提炼开关（off 省一次 LLM 调用） |

### 路径与观测

| 参数 | 默认 | 说明 |
|------|------|------|
| `PTH_WORKSPACES_PATH` / `PTH_ARTIFACTS_PATH` | /data/... | 工作区/产物根（compose 卷） |
| `PTH_SANDBOX_KERNEL_URL` | http://sandbox:8080 | sandbox kernel-host 地址 |
| `PTH_LOG_LEVEL` / `PTH_LOG_FORMAT` | info / json | 日志 |
| `PTH_METRICS_INTERVAL_MS` | - | 指标采样周期 |

## 4. 调优方法论（闭环四步）

```
1. 基线压测    → 发一批同质任务（如 20 个代码任务），记录吞吐/耗时/token
2. 瓶颈定位    → /metrics 四层指标（L1 kernel exec / L2 任务 / L3 产出）
                + /api/v1/kernel/status（分布/watchdog）+ obs 调查（会话内）
3. 参数调整    → 运行时 perf.set（不重启）或 env + 重启
4. 复测对比    → 同批任务重跑，对比吞吐/耗时/token 变化
```

常见瓶颈速查：

| 症状 | 参数 |
|------|------|
| 任务卡 claimed 后无进展 | 池容量不足 → `PTH_KERNEL_POOL_SIZE` 上调（≥worker 数） |
| 任务 pending 积压 | batch 太少 → `PTH_BATCH_MAX` 上调 / `PTH_BATCH_SCALE_UP_THRESHOLD` 下调 |
| 单任务慢（LLM 等待） | `PTH_AGENT_MODEL` 换更快模型 / `PTH_AGENT_MAX_STEPS` 收紧 |
| 大量 rejected | 描述问题（非性能）→ 检查任务 text 验收标准 |
| 内存吃紧 | `PTH_KERNEL_LAZY_SPAWN=1` + `PTH_KERNEL_IDLE_MS` 调小 + 池容量下调 |

## 5. 运行时调参（不重启——perf.set）

PTH 内置配置中心：agent 会话内 ts 程序可直接调（PTH_* 白名单）：

```ts
await perf.set({ PTH_AGENT_MAX_STEPS: 5 });   // 立即对后续任务生效
await perf.params();                          // 查看当前快照
await perf.analyze();                         // v1 规则诊断
```

env 与运行时 SET 的关系：启动时 env 快照载入 → 运行时 SET 覆盖 → 重启恢复 env 值。

## 6. 容器抽象（下一版本设计意图——v0.7 落地）

当前 `docker-compose.yaml` 是唯一拉起方式。下版本将**容器后端抽象**——允许不同容器技术：

```
┌─ 部署描述（声明式）─────────────────────┐
│  services: pi-platform/sandbox/postgres/redis │
│  env 统一（现有 PTH_* 全保留）                 │
│  volumes: workspaces/platform/...              │
└───────────────────────────────────────────┘
           ↓ 容器后端接口（抽象层）
┌────────────┬────────────┬─────────────┐
│ docker     │ podman     │ k8s         │
│ compose    │（无守护进程）│（生产集群）   │
└────────────┴────────────┴─────────────┘
```

迁移准备（现有代码已具备）：
- **参数不依赖 compose 插值**：全部走 `PTH_*` env（配置中心启动快照）——任何容器技术传 env 即可
- **镜像已独立**：`Dockerfile`（pi-platform）/ `Dockerfile.sandbox`（sandbox）——可推 GHCR
- **卷语义明确**：workspaces/platform/tenants/components/agent-dir/sessions/artifacts——抽象层映射
- **健康检查自带**：`/health` + compose healthcheck——k8s readiness/liveness 直接复用
- **网络隔离契约**：sandbox internal（零出口）——k8s 用 NetworkPolicy / podman 用 network mode 等价实现

## 7. 排障

| 现象 | 原因 | 处理 |
|------|------|------|
| 任务 503 unavailable | pg 未就绪/不可达 | `docker compose ps` 等 postgres healthy 再起 pi-platform |
| 任务卡 claimed | 池容量不足（acquire 排队超时） | `PTH_KERNEL_POOL_SIZE` ≥ 并发 worker 数 |
| sandbox 未 healthy | 镜像构建/密钥不匹配 | `docker compose logs sandbox`；SANDBOX_SHARED_SECRET 两端一致 |
| 任务长期 pending | 无 batch / autoscale 关 | `POST /api/v1/kernel/batch/add` 手动扩容；`PTH_BATCH_AUTOSCALE=on` |
| LLM 挂起冻结 | 模型 provider 慢 | 保持 `PTH_AGENT_LLM_TIMEOUT_MS=30000`（单次调用兜底） |
| 容器启动失败（file: 依赖） | 镜像缺 packages/ | 重新 `docker compose build`（builder+runtime 都 COPY packages/） |

## 8. 相关

- 任务提交（PTL 侧）：skill `pth-tasks` + `docs/ptl/pth-task-submission.md`
- PTH 内核体系：`docs/pth/kernel.md` · `docs/pth/architecture.md`
- 安全边界（sandbox 零敏感）：`docs/superpowers/specs/2026-08-08-pth-kernel-sandbox-design.md`
- 环境检查：`scripts/check-sandbox-env.sh`（发布门禁 `scripts/check-release-clean.sh`）
