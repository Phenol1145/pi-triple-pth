> PTH（Pi-Triple-Heavy）文档 — agent 联邦平台
# 部署指南

## 本地开发部署

### 前置条件

- Node.js >= 22
- Redis >= 7
- 至少一个 LLM API key（Anthropic / OpenAI / DeepSeek 等）

### 步骤

```bash
# 1. 克隆并安装
git clone <repo> && cd pi-platform
npm install

# 2. 启动 Redis
brew services start redis          # macOS
# 或: redis-server --daemonize yes

# 3. 设置 API key
export ANTHROPIC_API_KEY=sk-ant-...
# 或: export OPENAI_API_KEY=sk-...
# 或使用 pi 内置 auth.json（~/.pi/agent/auth.json 自动读取）

# 4. 创建认证 token
redis-cli SET "auth:token:dev-token" '{"tenantId":"dev-team"}'

# 5. 启动开发服务器（热重载）
npm run dev

# 6. 验证
curl http://localhost:3000/health
# → {"status":"ok","uptime":1.0}
```

---

## Docker 部署

### docker-compose

```bash
# 设置 API key
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...

# 启动
docker-compose up -d

# 验证
curl http://localhost:3000/health
```

### 手动 Docker

```bash
docker build -t pi-platform .
docker run -d \
  -p 3000:3000 \
  -e REDIS_URL=redis://redis-host:6379 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v pi-workspaces:/data/workspaces \
  pi-platform
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | HTTP 监听端口 |
| `REDIS_URL` | `redis://localhost:6379` | Redis 连接 URL |
| `DATA_DIR` | `./.pi-platform-data`（本地）/ `/data`（Docker） | 数据目录（workspaces/platform/tenants 的父目录） |
| `LOG_LEVEL` | `info` | pino 日志级别：`trace` / `debug` / `info` / `warn` / `error` |
| `PI_PLATFORM_PROVIDER` | 自动检测 | 模型提供商覆盖（如 `deepseek`）。需与 `PI_PLATFORM_MODEL` 同时设置 |
| `PI_PLATFORM_MODEL` | 自动检测 | 模型 ID 覆盖（如 `deepseek-v4-flash`）。需与 `PI_PLATFORM_PROVIDER` 同时设置 |
| `PI_ANTHROPIC_API_KEY` | - | Anthropic API key（平台层，pi SDK 默认读取） |
| `PI_OPENAI_API_KEY` | - | OpenAI API key（平台层） |
| `PI_GOOGLE_API_KEY` | - | Google Gemini API key（平台层，pi SDK 也可用 `GEMINI_API_KEY`） |
| `PI_OPENROUTER_API_KEY` | - | OpenRouter API key（平台层） |
| `ANTHROPIC_API_KEY` | - | Anthropic API key（SDK 层直接读取） |
| `OPENAI_API_KEY` | - | OpenAI API key（SDK 层直接读取） |
| `DEEPSEEK_API_KEY` | - | DeepSeek API key（SDK 层直接读取） |
| `GEMINI_API_KEY` | - | Google Gemini API key（SDK 层直接读取） |

**说明**：
- API key 优先从环境变量读取，其次从 pi SDK 的 `~/.pi/agent/auth.json` 读取
- `PI_*` 前缀的变量是平台层凭证（通过 `EnvCredentialProvider.getApiKey("platform", provider)` 读取）
- SDK 层支持的变量（如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`）会被 pi SDK 的 `ModelRuntime.create()` 自动读取
- `PI_PLATFORM_PROVIDER` 和 `PI_PLATFORM_MODEL` 必须同时设置，单独设置不会生效
- 不指定 provider/model 时，平台自动选择第一个可用模型

---

## Redis 配置

### 最低要求

- Redis >= 7
- 持久化：`appendonly yes`（session 记录用 append-only 模式）
- 可用内存：建议 >= 256MB

### 配置建议

**开发环境**：
```
redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy noeviction
```

**Docker 环境**（docker-compose.yaml 默认）：
```
redis-server --appendonly yes --maxmemory 1gb --maxmemory-policy allkeys-lru
```

> ⚠️ **生产注意**：`allkeys-lru` 可能淘汰 `auth:token:*` 等关键 key。生产环境建议：
> - 使用 `noeviction` 或 `volatile-lru` 策略
> - 为 auth token 设置合理的 TTL（`EX` 过期时间）
> - 配置 `notify-keyspace-events` 监控淘汰

### Redis Key 结构

```
auth:token:{token}                     → {"tenantId":"...","role":"..."}
session:{tenant}:{sessionId}:meta       → SessionMeta JSON
session:{tenant}:{sessionId}:entry:{seq} → SessionEntry JSON
session:{tenant}:{sessionId}:snapshot:{seq} → Snapshot JSON
session:{tenant}:{sessionId}:vsnapshot:{seq} → VersionSnapshotRecord JSON
session-index:{tenant}                  → ZSET (按时间排序的 session 索引)
settings:{tenant}:{project}             → Settings JSON
workflow:lock:{wfId}                    → Fencing token
workflow:intent:queue                   → BullMQ queue
```

**说明**：
- `session-index:{tenant}` 使用 Redis Sorted Set，score 为时间戳，member 为 `{"sessionId":"...","project":"..."}`
- entry 和 snapshot key 包含序号 `{seq}`，支持按序列号精确读取和重放
- version snapshot 记录每个 turn 的 skills/prompts/tools 文件 hash 快照

---

## 健康检查

### HTTP

```bash
curl http://localhost:3000/health
# → {"status":"ok","uptime":123.456}
```

Docker 容器使用同一端点作为 HEALTHCHECK，每 30 秒检查一次，最多重试 3 次。

### 日志

所有日志输出到 stdout（pino JSON 格式）：

```bash
# 启动时设置日志级别
LOG_LEVEL=debug npm run dev

# 查看 session 创建日志
grep "session_created" <log>
```

---

## Prometheus 监控

### 指标端点

```
GET /metrics
```

### 核心指标

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `pi_sessions_active` | Gauge | - | 当前活跃 session 数 |
| `pi_prompt_duration_seconds` | Histogram | - | prompt 处理时长 |
| `pi_tokens_total` | Counter | `tenant`, `type` | token 用量（input/output） |
| `pi_tool_calls_total` | Counter | `tool`, `tenant` | 工具调用次数 |
| `pi_workflow_steps_total` | Counter | - | 工作流步骤执行次数 |
| `pi_self_modify_total` | Counter | `layer` | 自修改次数（L1/L2/L3） |
| `process_resident_memory_bytes` | Gauge | - | 进程 RSS 内存（来自 prom-client 默认指标） |

### Prometheus 接入

```yaml
scrape_configs:
  - job_name: pi-platform
    static_configs:
      - targets: ['localhost:3000']
```

---

## Supervisor A/B 回滚

`scripts/supervisor.sh` 是 Layer 3 自修改的外部守护脚本。它在平台进程外部运行，提供 A/B 部署和健康检查回滚。

### 工作原理

```
supervisor.sh
  ├── 读取 /data/platform/releases/current 符号链接
  ├── npm ci + npm run build + node dist/main.js（启动新版本）
  ├── 健康检查（30s 内轮询 /health）
  ├── 失败 → 回滚到 previous release 符号链接
  ├── 检测 .rebuild-request 文件 → 触发重建
  └── 连续 3 次回滚 → 停止，等待人工介入
```

### 使用方式

```bash
# 在 Docker 外运行 supervisor
PLATFORM_DIR=/data/platform bash scripts/supervisor.sh

# 或作为 Docker entrypoint
docker run ... --entrypoint scripts/supervisor.sh
```

---

## 生产环境注意事项

1. **Redis 高可用**：使用 Redis Sentinel 或 Cluster，确保 session 数据不丢
2. **内存**：每个 session ~17MB RSS，按需调整 `maxSessions`（默认 20）
3. **日志**：stdout 输出，接入日志收集系统（ELK / Loki）
4. **指标**：Prometheus 抓取 `/metrics`，配置 Grafana 面板
5. **认证**：生产环境使用强随机 token，定期轮换
6. **工作区**：`DATA_DIR` 使用持久化卷，避免容器重启丢失
7. **BullMQ**：当前 worker 在主进程运行，高负载时建议独立进程
8. **Docker 资源限制**：docker-compose 中限制 4GB，按需调整
9. **优雅关闭**：平台支持 SIGINT / SIGTERM，执行 drain() 后退出
