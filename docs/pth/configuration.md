# PTH 配置

> 建立：2026-08-16（配置集中化改造）。
> **唯一真相源**：`src/pth/config/schema.ts` —— 所有 PTH 配置项（key / 类型 / 默认值 / secret / runtime / group / scope / description）在这里登记。
> 组件读配置统一走 `pthConfig()`（typed accessor）或 `config()`（ConfigCenter）；`src/pth` 与
> `packages/pth-sandbox/src` 内禁止 `process.env.PTH_*` 直读（`npm run check:pth-config` 防回潮）。
> pth-sandbox 包有独立单点 `packages/pth-sandbox/src/config.ts`（`loadSandboxConfig()`）——
> 同键名、对齐 schema 默认值；个别 sandbox 侧运行默认（`PTH_MEMORY_BRIDGE` 自循环 8080、
> `PTH_EXEC_PRIVATE_ROOT` 未注入时不启用）以该文件注释为准。

## 1. 加载链

```
env（compose --env-file deploy/.env.pth.secrets 注入）
   │
   ▼
src/pth/config/schema.ts        默认值（迁移前代码内联默认——行为兼容）
   │
   ▼
ConfigCenter（env 优先，schema 兜底）  ← set/on：runtime 键运行时可调（perf.set）
   │
   ├─ pthConfig().str/num/flag/enabled/list   —— 组件读取唯一入口
   ├─ snapshot(includeSecrets=false)          —— perf.params() 数据源（密钥默认打码）
   └─ validatePthConfig()                     —— PTH_CONFIG_STRICT=1 生产 fail-fast
```

## 2. 查看配置

```bash
pth config              # 分组表（默认值/runtime/scope；密钥 ***）
pth config export       # 输出 ptl config set pth.url/pth.token（PTL 迁移通道）
npm run check:pth-config -- --report  # schema 统计 + compose 覆盖度报告
```

## 3. 分类速览（153 键）

| group | 数量 | 说明 |
|---|---|---|
| agent | 5 | agent 模式/模型/步骤/超时 |
| optimizer | 6 | JIT 窗口/apply 策略/verify 复测 |
| autopilot | 8 | R1–R4 阈值与周期 |
| scaler | 10 | batch 扩缩/强化 |
| control-loop | 7 | claim/watchdog/resolver/memory-sweep trigger 周期 |
| kernel | 9 | 语言模式/池/会话 |
| compiled | 5 | 编译核缓存/并发/超时 |
| memory | 2 | 记忆桥 URL/token |
| guard | 6 | 连续失败阈值（runtime） |
| cache | 2 | cache-store 上限（runtime） |
| model | 5 | modelRouter/NL/stub/PTC 模型 |
| path | 29 | 源码根/工作区/通知/沙箱路径 |
| mode | 24 | 执行模式/ASP/refine/skill 策略/batch 标志/N28 认知责任模式 |
| observability | 4 | metrics 周期/日志 |
| worker | 6 | workload/workspace UID/GID/N28 batch ID |
| execution | 6 | Execute/Command/Tool 层配置 |
| secret | 8 | grant/共享密钥/桥 token/PG/Redis/LLM key |
| infra | 7 | DATABASE/REDIS/DATA_DIR/SANDBOX_URL 等 |
| cli | 4 | PTH_API/TOKEN/CREATED_BY/URL |

`runtime=true` 的键可经 `perf.set({key,value})` 运行时调整（重启失效；ALTER SYSTEM 持久化留 v2）。

N28 T2 新增两键（默认关闭/空，legacy 行为不变）：`PTH_COGNITIVE_RESPONSIBILITY_MODE=off`
（可选 `feasibility` 确定性切片）与 `PTH_BATCH_ID=""`（BatchManager 注入的 batch 实例 ID）。

## 4. Secrets（统一文件 + 核心密钥 `:?` fail-closed）

- **文件**：`deploy/.env.pth.secrets`（gitignored；模板 `deploy/.env.pth.secrets.example`）。
- **启动**：
  ```bash
  cp deploy/.env.pth.secrets.example deploy/.env.pth.secrets   # 替换成真实值
  docker compose --env-file deploy/.env.pth.secrets -f deploy/docker-compose.yaml up -d
  # dev: ... -f deploy/docker-compose.dev.yaml（叠加 PTH_CONFIG_STRICT=0）
  ```
- **核心密钥 `:?`**：`SANDBOX_SHARED_SECRET`、`PTH_EXECUTION_GRANT_SECRET`、`PTH_MEMORY_BRIDGE_TOKEN`、
  `POSTGRES_PASSWORD`、`REDIS_PASSWORD` 任一缺失 → compose 拒绝启动。
- **可选后端密钥 `:-`**：`LOCAL_EXEC_SHARED_SECRET`、`JUPYTER_SERVICE_TOKEN` 在 engine compose 中为
  可选注入（缺失时对应 backend 运行期 401，不阻塞核心栈启动）；jupyter 自身 compose 对
  `JUPYTER_SERVICE_TOKEN` 仍是 `:?`（起 jupyter 前必须先 export）。
- **REDIS/DATABASE_URL 分字段拼装**（不再把密码嵌进连接串默认值）；redis 启用 AUTH。
- **生产严格校验**：compose 注入 `PTH_CONFIG_STRICT=1`，主进程启动时拒绝弱密钥（grant secret <32、
  shared secret/token <16）与显式开发默认 token。
- **打码面**：`config().snapshot()` / `pth config` 对 secret 一律 `***`；worker 的 `perf.params()` 不再能读到密钥。
- LLM 模型密钥仍由 `pi auth.json` 单源注入 env（`injectPiAiKeysFromAuth`）——文件凭据不进入本 schema。

## 5. 兼容性

- 全部默认值与迁移前代码内联默认一致（schema 即基线）；
- `kernel/extensions/perf-params.ts` 是 ConfigCenter 的兼容 re-export——旧 import 面不破坏；
- PTL 侧配置（`pi-triple.json`/模板）不纳入本 schema，只经 `pth config export` 提供信息迁移通道。
