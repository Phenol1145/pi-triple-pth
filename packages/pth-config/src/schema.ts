/**
 * schema.ts —— PTH 配置 schema（配置集中化 C1，2026-08-16）。
 *
 * 这是 PTH 全部可配置项的唯一真相源：
 *   - key/type/default：默认值 = 迁移前代码内联默认值（行为兼容）；
 *   - secret：true → snapshot/dump/日志一律打码（worker perf.params 也不可见）；
 *   - runtime：true → 运行时可经 ConfigCenter.set（perf.set）动态调整；
 *   - scope：该项主要生效面（main=主进程 / batch=batch 子进程 / sandbox=sandbox 容器 / cli=命令行 / compose=部署编排）。
 *
 * 新增配置项 = 在这里加一行（随后 pth config list / docs / compose 覆盖度检查自动可见）。
 */

export type ConfigValueType = "string" | "number" | "boolean" | "string[]" | "json";
export type ConfigScope = "main" | "batch" | "sandbox" | "cli" | "compose" | "both";
export type ConfigGroup =
  | "infra"
  | "secret"
  | "agent"
  | "optimizer"
  | "autopilot"
  | "scaler"
  | "control-loop"
  | "kernel"
  | "compiled"
  | "memory"
  | "guard"
  | "cache"
  | "model"
  | "path"
  | "mode"
  | "observability"
  | "worker"
  | "execution"
  | "cli";

export interface PthConfigDef {
  key: string;
  type: ConfigValueType;
  /** 未设置 env 时的默认值（行为兼容基线——与迁移前代码内联默认一致） */
  default: string | number | boolean | null;
  secret?: boolean;
  runtime?: boolean;
  /** C11：number 类型资源的护栏范围（越界 warn + 回退/clamp） */
  min?: number;
  max?: number;
  group: ConfigGroup;
  scope: ConfigScope;
  description: string;
}

const d = (
  key: string,
  type: ConfigValueType,
  defaultValue: string | number | boolean | null,
  group: ConfigGroup,
  scope: ConfigScope,
  description: string,
  opts: { secret?: boolean; runtime?: boolean; min?: number; max?: number } = {},
): PthConfigDef => ({ key, type, default: defaultValue, group, scope, description, ...opts });

export const PTH_CONFIG_SCHEMA: PthConfigDef[] = [
  // ── 基础设施 / 密钥 ──────────────────────────────────────────────
  d("DATABASE_URL", "string", "", "secret", "both", "PTH kernel 存储（postgres）连接串——compose 注入", { secret: true }),
  d("REDIS_URL", "string", "redis://localhost:6379", "infra", "main", "Redis 连接串（auth token 存储）", { secret: true }),
  d("REDIS_PASSWORD", "string", "", "secret", "compose", "Redis AUTH 密码（生产 :? 必填；URL 分字段拼装）", { secret: true }),
  d("POSTGRES_PASSWORD", "string", "", "secret", "compose", "postgres 密码（生产 :? 必填，无开发默认值）", { secret: true }),
  d("SANDBOX_URL", "string", "http://localhost:8080", "infra", "main", "sandbox 转发基址"),
  d("SANDBOX_SHARED_SECRET", "string", "", "secret", "both", "sandbox 控制器间共享密钥（:? 强校验；本地 fail-closed）", { secret: true }),
  d("SANDBOX_DEGRADED_THRESHOLD", "number", 3, "infra", "main", "sandbox 连续失败降级阈值"),
  d("DATA_DIR", "string", "./.pi-platform-data", "path", "main", "PTH 数据根目录"),
  d("NODE_OPTIONS", "string", "", "infra", "both", "Node 运行参数（compose 内存上限）"),
  d("LOG_LEVEL", "string", "info", "observability", "both", "进程日志级别（pino 侧）"),
  d("PI_OPENAI_API_KEY", "string", "", "secret", "main", "OpenAI API key（compose 可选透传）", { secret: true }),
  d("PI_ANTHROPIC_API_KEY", "string", "", "secret", "main", "Anthropic API key（compose 可选透传）", { secret: true }),

  // ── agent ────────────────────────────────────────────────────────
  d("PTH_AGENT_MODE", "string", "auto", "agent", "both", "Prompt 框架模式：eager/lazy/auto（auto=角色类缺省：规划系 eager，其余 lazy；off 关闭）"),
  d("PTH_AGENT_MODEL", "string", "deepseek-v4-flash", "model", "batch", "agent 默认模型", { runtime: true }),
  d("PTH_AGENT_MAX_STEPS", "number", 10, "agent", "batch", "agent 循环步骤上限（代码默认 10；compose 300）", { runtime: true }),
  d("PTH_AGENT_CONTEXT_WINDOW", "number", 128_000, "agent", "batch", "agent 上下文窗口（token 估计——循环内压缩触发阈值）", { runtime: true }),
  d("PTH_AGENT_TIMEOUT_MS", "number", 120_000, "agent", "batch", "agent 任务级超时（代码默认 120s；compose 3h）", { runtime: true }),
  d("PTH_AGENT_LLM_TIMEOUT_MS", "number", 30_000, "agent", "batch", "单次 LLM 调用超时", { runtime: true }),
  d("PTH_AGENT_STALL_LOG_MS", "number", 60_000, "agent", "batch", "agent 等待点停滞告警阈值（超过打 agent-stall warn）", { runtime: true }),
  d("PTH_AGENT_STEP_TIMEOUT_MS", "number", 300_000, "agent", "batch", "ts.run/ts.eval 单步执行超时（超时=工具失败回灌模型，不终止任务）", { runtime: true }),
  d("PTH_TRANSCRIPT_CONTEXT", "string", "on", "agent", "batch", "任务上下文快照持久化开关（on=压缩前+结束时快照随 transcript 落盘；off=不采集）", { runtime: true }),
  d("PTH_TRANSCRIPT_CONTEXT_MAX_CHARS", "number", 500_000, "agent", "batch", "单任务上下文快照持久化字符上限（超出按快照从旧到新丢弃，始终保留 final）", { runtime: true }),
  d("PTH_WORKER_CONTEXT_MAX_CHARS", "number", 200_000, "agent", "batch", "worker 在飞上下文查询 IPC 投影字符上限（超出从旧到新丢消息并标 truncated）", { runtime: true }),

  // ── optimizer / JIT ──────────────────────────────────────────────
  d("PTH_OPTIMIZER", "string", "on", "optimizer", "batch", "优化循环开关（off 关闭）", { runtime: true }),
  d("PTH_OPTIMIZER_WINDOW", "number", 10, "optimizer", "batch", "热点检测窗口任务数", { runtime: true }),
  d("PTH_APPLY_POLICY", "string", "manual", "optimizer", "batch", "建议应用策略：manual / auto-reversible", { runtime: true }),
  d("PTH_VERIFY_TASKS", "number", 3, "optimizer", "batch", "复测任务证据数（一等化）", { runtime: true }),
  d("PTH_VERIFY_TIMEOUT_MS", "number", 30 * 60_000, "optimizer", "batch", "复测超时（超时零进展 → verify_expired）", { runtime: true }),
  d("PTH_VERIFY_SWEEP_MS", "number", 30_000, "optimizer", "main", "optimizer.deopt-sweep trigger 周期", { runtime: true }),

  // ── autopilot ────────────────────────────────────────────────────
  d("PTH_AUTOPILOT_MODE", "string", "off", "autopilot", "main", "PerfAutopilot 开关（on 启用）", { runtime: true }),
  d("PTH_AUTOPILOT_INTERVAL_MS", "number", 30_000, "autopilot", "main", "autopilot tick 周期", { runtime: true }),
  d("PTH_AUTOPILOT_WINDOW_MS", "number", 60_000, "autopilot", "main", "指标窗口/冷却窗口", { runtime: true }),
  d("PTH_AUTOPILOT_REJECT_RATE", "number", 0.3, "autopilot", "main", "R4 reject 率阈值", { runtime: true }),
  d("PTH_AUTOPILOT_EXEC_FAIL_RATE", "number", 0.2, "autopilot", "main", "R3 exec 失败率阈值", { runtime: true }),
  d("PTH_AUTOPILOT_LLM_SLOW_MS", "number", 30_000, "autopilot", "main", "R2 LLM 慢阈值", { runtime: true }),
  d("PTH_AUTOPILOT_PENDING_GROWTH", "number", 1.3, "autopilot", "main", "R1 pending 增长阈值", { runtime: true }),
  d("PTH_AUTOPILOT_MAX_COPIES", "number", 4, "autopilot", "main", "R1 单轮强化副本上限", { runtime: true }),

  // ── batch / scaler ───────────────────────────────────────────────
  d("PTH_BATCH_AUTOSCALE", "string", "off", "scaler", "main", "batch 自动扩缩开关（on 启用）", { runtime: true }),
  d("PTH_BATCH_MIN", "number", 1, "scaler", "main", "batch 数量下限", { min: 1, max: 32 }),
  d("PTH_BATCH_MAX", "number", 4, "scaler", "main", "batch 数量上限", { min: 1, max: 64 }),
  d("PTH_BATCH_SCALE_INTERVAL_MS", "number", 30_000, "scaler", "main", "batch-scaler trigger 周期", { runtime: true }),
  d("PTH_BATCH_SCALE_UP_THRESHOLD", "number", 5, "scaler", "main", "pending 扩容阈值", { runtime: true }),
  d("PTH_AUTOSCALE_MODE", "string", "balanced", "scaler", "main", "扩容模式：balanced / reinforced", { runtime: true }),
  d("PTH_AUTOSCALE_ROLE_THRESHOLD", "number", 5, "scaler", "main", "reinforced 单角色积压阈值", { runtime: true }),
  d("PTH_AUTOSCALE_REINFORCE_COPIES", "number", 2, "scaler", "main", "reinforced 强化副本数", { runtime: true }),
  d("PTH_BATCH_TICK_MS", "number", 1000, "scaler", "batch", "batch 认领心跳 tick（空闲退避）"),
  d("PTH_BATCH_ID", "string", "", "worker", "batch", "N28：本 batch 实例 ID（BatchManager.spawnBatch 注入子进程；缺省空=未由 BatchManager 启动）"),
  d("PTH_COGNITIVE_RESPONSIBILITY_MODE", "string", "off", "mode", "batch", "N28：认知责任模式——off=legacy 逐字节兼容（默认）/ feasibility=确定性可行性切片"),
  d("PTH_KNOWLEDGE_INTAKE_MODE", "string", "off", "mode", "both", "N29：知识摄入模式——off=关闭（默认）/ draft=仅私有草稿 / full=完整内环（MIN_INNER_LOOP_GO 前不得启用）"),
  d("PTH_BATCH_HEALTH_STALE_MS", "number", 15_000, "scaler", "main", "batch 心跳陈旧判定阈值（listBatches 健康面 healthy/stale——与 watchdog HEARTBEAT_STALE_MS 同档）", { runtime: true }),
  d("PTH_WORKER_ROLES", "string", "", "worker", "both", "batch 构成参数化（角色:副本数逗号分隔；空=默认构成）"),
  d("PTH_PG_POOL_MAX", "number", 8, "infra", "batch", "batch 子进程 PG 连接池上限"),

  // ── 控制环（trigger 统一化） ─────────────────────────────────────
  d("PTH_CLAIM_REAP_MS", "number", 30_000, "control-loop", "main", "claim-reaper trigger 周期", { runtime: true }),
  d("PTH_CLAIM_TIMEOUT_MS", "number", 0, "control-loop", "main", "claim 超时（0=派生：任务超时 +10min 或 600s）", { runtime: true }),
  d("PTH_WATCHDOG_INTERVAL_MS", "number", 30_000, "control-loop", "main", "batch-watchdog trigger 周期"),
  d("PTH_RESOLVER_INTERVAL_MS", "number", 2_000, "control-loop", "main", "flow-resolver 基础周期"),
  d("PTH_MEMORY_SWEEP_SECONDS", "number", 24 * 60 * 60, "control-loop", "main", "记忆巡检 trigger 周期（0=禁用）"),
  d("PTH_GOVERNANCE_LOOP", "string", "off", "control-loop", "main", "sensor/controller 治理回路调度源开关（on 启用）", { runtime: true }),
  d("PTH_GOVERNANCE_LOOP_INTERVAL_SECONDS", "number", 24 * 60 * 60, "control-loop", "main", "sensor/controller 周期派单间隔秒"),
  d("PTH_GOVERNANCE_BASELINE_WINDOW", "number", 10, "control-loop", "main", "A/B 优化周期基线窗轮数 n"),
  d("PTH_TASK_PAUSE_TIMEOUT_MS", "number", 24 * 60 * 60 * 1000, "control-loop", "both", "pause 超时（缺省 24h——超时 escalated）", { runtime: true }),
  d("PTH_TASK_PAUSE_SWEEP_MS", "number", 60_000, "control-loop", "main", "pause 巡检周期（超时/预算）", { runtime: true }),
  d("PTH_TASK_LEASE_RECOVERY", "string", "on", "control-loop", "batch", "孤儿 claim 周期回收开关（off=回退现状，recoverExpired 不被调用）", { runtime: true }),
  d("PTH_TASK_LEASE_RECOVERY_GRACE_MS", "number", 60_000, "control-loop", "batch", "租约回收保护窗（lease_expires_at < now - grace 才回收）", { runtime: true }),

  // ── kernel / 执行 ────────────────────────────────────────────────
  d("PTH_KERNEL_LAZY_SPAWN", "string", "1", "kernel", "batch", "懒 spawn（0=构造即起）", { runtime: true }),
  d("PTH_KERNEL_IDLE_MS", "number", 300_000, "kernel", "batch", "kernel 空闲回收（0=禁用）", { runtime: true }),
  d("PTH_KERNEL_RESET_MODE", "string", "ns", "kernel", "batch", "reset 语义：ns / restart", { runtime: true }),
  d("PTH_KERNEL_POOL_SIZE", "number", 24, "kernel", "sandbox", "sandbox kernel 宿主池容量", { min: 1, max: 256 }),
  d("PTH_KERNEL_ACQUIRE_TIMEOUT_MS", "number", 10_000, "kernel", "sandbox", "池 acquire 排队超时"),
  d("PTH_KERNEL_ENTRY_TTL_MS", "number", 30 * 60_000, "kernel", "sandbox", "kernel 池条目 TTL"),
  d("PTH_PYTHON_MODE", "string", "kernel", "kernel", "batch", "python 执行模式：kernel / sandbox-kernel"),
  d("PTH_BASH_MODE", "string", "kernel", "kernel", "batch", "bash 执行模式：kernel / sandbox-kernel"),
  d("PTH_EXEC_SESSION_TTL_MS", "number", 30 * 60_000, "kernel", "main", "kernel 直连执行会话 TTL"),

  // ── execution 后端注册（P1：execution/v1.1 路由，三仓 topology §4） ──
  d("PTH_EXEC_BACKENDS", "json", "", "execution", "both", "ExecutionBackendDescriptor[] JSON；空 + sandbox alias 开 → 合成 sandbox 后端"),
  d("PTH_EXEC_BACKEND_ROUTES", "json", "", "execution", "both", "ProfessionalRuntimeId → backend id 路由表 JSON（如 {\"lean4\":\"local-lean\"}）"),
  d("PTH_EXEC_BACKEND_PROBE_TIMEOUT_MS", "number", 2000, "execution", "both", "startup 单 backend capabilities 探测超时"),
  d("PTH_EXEC_SANDBOX_ALIAS", "string", "on", "execution", "both", "sandbox 后端自动合成开关（off 关闭；只影响未显式配置 sandbox 的情况）"),
  d("PTH_TOOL_TOOLS_DIR", "string", "", "path", "cli", "deploy/tool-containers 目录（缺省 = 仓库内）"),
  d("PTH_TOOL_REGISTRY_PATH", "string", "", "path", "cli", "宿主 tool containers 回环注册表路径（缺省 ~/.pi-triple/tool-containers.json）"),
  d("PTH_ASM_KERNEL_INDEX_PATH", "string", "", "path", "batch", "asm-kernel index.js 生产路径（容器内 /data/toolstore/...；空 = 仓库默认）"),
  d("PTH_SERVICES_DIR", "string", "", "path", "cli", "deploy/services 根目录（缺省 = 仓库内）"),
  d("PTH_SERVICES_PROJECT", "string", "pi-triple-services", "path", "cli", "pth services 的 docker compose 项目名"),
  d("PTH_SERVICE_REGISTRY_PATH", "string", "", "path", "cli", "宿主服务运行时注册表路径（缺省 ~/.pi-triple/services.json）"),
  d("PTH_PTH_BIN", "string", "", "path", "cli", "pth 可执行路径覆盖（缺省 PATH 中的 pth；本地开发可用 node dist/cli/pth-cli.js）"),
  d("LOCAL_EXEC_SHARED_SECRET", "string", "", "secret", "cli", "本地执行器 Bearer token（pth local-exec；缺失 fail-closed）", { secret: true }),
  d("LOCAL_EXEC_PORT", "string", "8787", "execution", "cli", "本地执行器监听端口（pth local-exec 默认 8787）"),
  d("LOCAL_EXEC_PATH_MAPPINGS", "json", "", "execution", "cli", "本地执行器 pathMapping JSON：[{hostRoot,execRoot}]"),
  d("LOCAL_EXEC_WORKSPACE_ROOT", "string", "", "path", "cli", "本地执行器快捷映射：/data/workspaces → 该宿主根"),

  // ── compiled kernel ──────────────────────────────────────────────
  d("PTH_COMPILED_CACHE_DIR", "string", "/data/compiled-cache/c", "compiled", "sandbox", "编译核缓存目录"),
  d("PTH_COMPILED_CACHE_MAX_MB", "number", 200, "compiled", "sandbox", "编译缓存容量上限（MB）"),
  d("PTH_COMPILED_MAX_CACHE", "number", 50, "compiled", "sandbox", "编译缓存条目上限"),
  d("PTH_COMPILED_TIMEOUT_MS", "number", 60_000, "compiled", "sandbox", "编译超时"),
  d("PTH_COMPILED_CONCURRENCY", "number", 4, "compiled", "sandbox", "编译并发上限", { min: 0, max: 64 }),

  // ── 记忆 / 桥 ────────────────────────────────────────────────────
  d("PTH_MEMORY_BRIDGE", "string", "http://localhost:3000/api/v1/kernel/memory-bridge", "memory", "batch", "记忆桥上游 URL"),
  d("PTH_MEMORY_BRIDGE_TOKEN", "string", "", "memory", "both", "记忆桥 Bearer token（生产 :? 必填）", { secret: true }),

  // ── guard ────────────────────────────────────────────────────────
  d("PTH_GUARD_REPEAT_LIMIT", "number", 5, "guard", "batch", "连续重复动作 soft 阈值", { runtime: true }),
  d("PTH_GUARD_EMPTY_DONE_LIMIT", "number", 3, "guard", "batch", "空 done hard 阈值", { runtime: true }),
  d("PTH_GUARD_EMPTY_REPLY_LIMIT", "number", 3, "guard", "batch", "空回复 hard 阈值", { runtime: true }),
  d("PTH_GUARD_UNKNOWN_TOOL_LIMIT", "number", 3, "guard", "batch", "未知工具 hard 阈值", { runtime: true }),
  d("PTH_GUARD_NEGATIVE_LIMIT", "number", 15, "guard", "batch", "负结果收敛强制终止阈值", { runtime: true }),
  d("PTH_GUARD_NEGATIVE_GUIDE_AT", "number", 3, "guard", "batch", "负结果引导阈值", { runtime: true }),

  // ── cache ────────────────────────────────────────────────────────
  d("PTH_CACHE_MAX_CHARS", "number", 16 * 1024, "cache", "batch", "cache-store 字符上限", { runtime: true }),
  d("PTH_CACHE_MAX_ENTRIES", "number", 20, "cache", "batch", "cache-store 条目上限", { runtime: true }),

  // ── model ────────────────────────────────────────────────────────
  d("PTH_MODEL_PROVIDER", "string", "deepseek", "model", "batch", "kernel modelRouter provider", { runtime: true }),
  d("PTH_MODEL", "string", "deepseek-v4-flash", "model", "batch", "kernel modelRouter model", { runtime: true }),
  d("PTH_NL_MODEL", "string", "deepseek-v4-flash", "model", "batch", "自然语言任务转译模型"),
  d("PTH_LLM_STUB", "string", "0", "model", "both", "LLM stub 模式（1 开启）"),

  // ── 路径 / URL ───────────────────────────────────────────────────
  d("PTH_SOURCE_ROOT", "string", "/app/src", "path", "batch", "worker readSource 只读源码根"),
  d("PTH_TOOLSTORE_PATH", "string", "", "path", "both", "toolstore 文件通道目录（batch 侧缺省 toolstore）"),
  d("PTH_WORKSPACES_PATH", "string", "/tmp/pth-workspaces", "path", "batch", "任务工作区根"),
  d("PTH_ARTIFACTS_PATH", "string", "/tmp/pth-artifacts", "path", "batch", "产物归档根"),
  d("PTH_SANDBOX_KERNEL_URL", "string", "http://sandbox:8080", "path", "both", "sandbox kernel 宿主 URL"),
  d("PTH_NOTIFY_URL", "string", "http://host.docker.internal:19473/pth-events", "path", "batch", "任务完成通知 URL"),
  d("PTH_NOTIFY_PORT", "number", 19_473, "path", "main", "通知端口（PTL 侧注入）"),
  d("PTH_BRIDGE_URL", "string", "http://pi-platform:3000", "path", "sandbox", "sandbox → pi-platform 桥基址"),
  d("PTH_TEST_DATABASE_URL", "string", "", "infra", "batch", "测试/子进程数据库 URL（优先于 DATABASE_URL）"),
  d("PTH_EXEC_PRIVATE_ROOT", "string", "/srv/workload", "path", "sandbox", "工作负载私有根"),
  d("PTH_DEBUG_WORKDIR", "string", "/data/workspaces", "path", "sandbox", "调试会话工作根"),
  d("PTH_DEBUG_IDLE_MS", "number", 30 * 60_000, "path", "sandbox", "调试会话空闲回收"),
  d("PTH_DEBUG_SESSIONS", "number", 4, "path", "sandbox", "调试会话并发上限", { min: 1, max: 64 }),
  d("PTH_DEBUG_SANDBOX", "string", "0", "path", "sandbox", "sandbox 诊断日志开关"),
  d("PTH_TRUST_POLICY_MANIFEST", "string", "", "path", "both", "N29：人类签名 Trust Policy manifest 只读路径（JSON；PTL Human Interface 签发）"),
  d("PTH_TRUST_POLICY_KEYRING", "string", "", "path", "both", "N29：Trust Policy 验证公钥 keyring 只读路径（JSON；stable human principal -> PEM public key）"),
  d("PTH_KNOWLEDGE_INTAKE_ACCEPTANCE_PATH", "string", "", "path", "both", "N29 refix P0-9：full 模式启动必须出示的验收 envelope 只读路径（decision=MIN_INNER_LOOP_GO 且绑定当前 evaluated commit，否则启动失败）"),
  d("PTH_KNOWLEDGE_INTAKE_ACCEPTANCE_PUBLIC_KEY_PATH", "string", "", "path", "both", "N29 refix D-5：full 模式验收 envelope 签名公钥只读路径（Ed25519 PEM；full 启动必须验签，否则启动失败）"),
  d("PTH_WOLFRAM_KERNEL_PATH", "string", "", "path", "batch", "v1.3 P3：Wolfram Engine 内核路径（仅服务端；license 数据绝不进任务载荷/产物/日志）"),
  d("PTH_WOLFRAM_LICENSE_PROVIDER", "string", "", "mode", "batch", "v1.3 P3：license provider 标识（license 值由运行时安全注入，schema 绝不记录密钥本身）"),
  d("PTH_ASM_TOOLCHAIN_EXEC", "string", "", "mode", "batch", "v1.3 P2：assembly adapter 测试容器注入前缀（生产缺省直跑）"),
  d("PTH_LEAN4_TOOLCHAIN_EXEC", "string", "", "mode", "batch", "v1.3 P3：lean4 adapter 测试容器注入前缀"),
  d("PTH_U8_TOOLCHAIN_EXEC", "string", "", "mode", "batch", "U8-1：u8 adapter 测试容器注入前缀（生产缺省经 local-u8 执行面）"),
  d("PTH_LEAN4_PACKAGES_DIR", "string", "/home/node/lean-packages", "path", "batch", "v1.3 P3：Mathlib 共享 cache 目录（容器内）"),
  d("PTH_LEAN4_TEMPLATE_DIR", "string", "/home/node/lean-template", "path", "batch", "v1.3 P3：已构建 Mathlib 模板工程目录"),

  // ── 模式 / 开关 / 观测 ───────────────────────────────────────────
  d("PTH_EXEC_MODE", "string", "tool-call", "mode", "both", "执行模式统一入口：tool-call / asp / ptc / pulse（显式优先；非法值 fail-fast）"),
  d("PTH_PTC_MAX_ITERATIONS", "number", 5, "mode", "batch", "PTC 迭代模式最大轮数", { runtime: true }),
  d("PTH_PTC_MODEL", "string", "", "mode", "batch", "PTC 迭代模式使用的模型（空 = 沿用 agent 默认模型）", { runtime: true }),
  d("PTH_PTC_TIMEOUT_MS", "number", 120_000, "mode", "batch", "PTC 迭代模式任务级超时", { runtime: true }),
  d("PTH_ASP_MODE", "string", "off", "mode", "batch", "动作空间协议（双轨并行：平铺为主验证路径——默认关闭；on 对照 ASP 轨）"),
  d("PTH_REFINE", "string", "auto", "mode", "batch", "任务完成后 refine（off 关闭）"),
  d("PTH_SKILL_WRITE_POLICY", "string", "manual", "mode", "batch", "skill 写策略：manual / staged"),
  d("PTH_TOOL_WRITE_POLICY", "string", "manual", "mode", "batch", "tool-reg 注册写策略（N14）：manual / staged（W5 同款）"),
  d("PTH_TOOL_FACE_BUDGET", "number", 24, "mode", "batch", "每角色工具面预算（N14 §3.3 预算守卫——注册工具面超限裁减）", { runtime: true }),
  // ── N15：穿透执行预算 + 自动发现（docs/pth/design/n15-lane-b1-b2-a4-design.md）──
  d("PTH_PENETRATION_MAX_STEPS", "number", 40, "mode", "batch", "单次穿透调用子 agent 步数上限", { runtime: true }),
  d("PTH_PENETRATION_TASK_BUDGET_STEPS", "number", 80, "mode", "batch", "同一父任务全部穿透调用累计步数上限", { runtime: true }),
  d("PTH_PENETRATION_TIMEOUT_MS", "number", 300_000, "mode", "batch", "单次穿透子 agent 超时", { runtime: true }),
  d("PTH_PENETRATION_DISCOVERY_INTERVAL_MS", "number", 600_000, "mode", "main", "穿透稳定边发现巡检周期"),
  d("PTH_PENETRATION_DISCOVERY_MIN_CALLS", "number", 5, "mode", "main", "穿透边累计调用数门槛"),
  d("PTH_PENETRATION_DISCOVERY_MIN_OK_RATIO", "number", 0.8, "mode", "main", "穿透边成功率门槛"),
  d("PTH_PENETRATION_DISCOVERY_MAX_AVG_STEPS", "number", 60, "mode", "main", "穿透边平均步数上限（昂贵边不固化）"),
  d("PTH_BATCH_PROCESS", "string", "0", "mode", "batch", "batch 子进程入口标志（1=子进程）"),
  d("PTH_BATCH_TS", "string", "0", "mode", "main", "dev 源码模式（1=tsx loader）"),
  d("PTH_METRICS_INTERVAL_MS", "number", 5_000, "observability", "main", "prom-client 采样周期"),
  d("PTH_LOG_FORMAT", "string", "json", "observability", "main", "日志格式：json / pretty"),
  d("PTH_LOG_LEVEL", "string", "info", "observability", "both", "PTH 日志级别"),

  // ── worker 身份 / workspace owner（sandbox 容器） ────────────────
  d("PTH_WORKLOAD_UID", "number", 2001, "worker", "sandbox", "工作负载 UID（容器内注入）"),
  d("PTH_WORKLOAD_GID", "number", 2001, "worker", "sandbox", "工作负载 GID"),
  d("PTH_WORKSPACE_OWNER_UID", "number", 1000, "worker", "sandbox", "工作区属主 UID"),
  d("PTH_WORKSPACE_OWNER_GID", "number", 1000, "worker", "sandbox", "工作区属主 GID"),

  // ── 部署 / CLI ───────────────────────────────────────────────────
  d("PTH_EXECUTION_GRANT_SECRET", "string", "", "secret", "both", "执行 grant 签名密钥（:? 必填；与 sandbox 同值）", { secret: true }),
  d("PTH_PROFESSIONAL_GRANT_TTL_MS", "number", 1_800_000, "execution", "batch", "professional.execute 任务级 grant TTL（默认 30min；按任务时长可调）", { runtime: true }),
  d("PTH_TOKEN", "string", "test-token-123", "cli", "cli", "PTH CLI/API Bearer token（生产禁开发默认值）", { secret: true }),
  d("PTH_CREATED_BY", "string", "cli", "cli", "cli", "CLI 发布任务的 createdBy"),
  d("PTH_API", "string", "http://localhost:3000", "cli", "cli", "pth CLI 的 API 基址"),
  d("PTH_URL", "string", "http://localhost:3000", "cli", "cli", "pth-tasks 扩展的 PTH 基址"),
  d("PTH_PLATFORM", "string", "", "infra", "main", "平台标识（缺省 = os.platform()）"),
];

export const PTH_CONFIG_MAP = new Map(PTH_CONFIG_SCHEMA.map((c) => [c.key, c]));

export function getConfigDef(key: string): PthConfigDef | undefined {
  return PTH_CONFIG_MAP.get(key);
}

export function secretConfigKeys(): string[] {
  return PTH_CONFIG_SCHEMA.filter((c) => c.secret).map((c) => c.key);
}

export function runtimeConfigKeys(): string[] {
  return PTH_CONFIG_SCHEMA.filter((c) => c.runtime).map((c) => c.key);
}
