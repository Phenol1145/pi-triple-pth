/**
 * pth-sandbox 配置单点（模块专项 ③ 配置收口）。
 *
 * 规则：本包内除本文件外禁止直读 `process.env.PTH_*`（scripts/check-pth-config.ts 机器强制）。
 * 键名与默认值对齐 src/pth/config/schema.ts（107 键唯一真相源）；
 * 个别 sandbox 侧运行默认与 host 侧不同（如 PTH_MEMORY_BRIDGE）以本文件注释为准。
 */

export interface SandboxConfig {
  /** 记忆桥 URL（sandbox 侧自循环 kernel-host 端口；host/batch 侧同键默认见 src/pth config schema） */
  memoryBridge: string;
  /** 记忆桥 Bearer token（controller-only，绝不注入 workload 进程） */
  memoryBridgeToken: string;
  /** kernel 宿主池容量（schema 默认 24） */
  kernelPoolSize: number;
  /** 池 acquire 排队超时（schema 默认 10000ms） */
  kernelAcquireTimeoutMs: number;
  /** 池条目 TTL（schema 默认 1800000ms） */
  kernelEntryTtlMs: number;
  /** 编译核缓存目录 */
  compiledCacheDir: string;
  /** 编译缓存容量上限（MB） */
  compiledCacheMaxMb: number;
  /** 编译缓存条目上限 */
  compiledMaxCache: number;
  /** 编译超时（ms） */
  compiledTimeoutMs: number;
  /** 编译并发上限 */
  compiledConcurrency: number;
  /** sandbox → pi-platform 桥基址 */
  bridgeUrl: string;
  /** workload 私有根（P0-3） */
  execPrivateRoot: string | undefined;
  /** gdb 调试工作根 */
  debugWorkdir: string;
  /** gdb 调试会话空闲回收（ms） */
  debugIdleMs: number;
  /** gdb 调试会话并发上限 */
  debugSessions: number;
  /** sandbox 诊断日志开关（任何非空值视为开） */
  debugSandbox: boolean;
  /** workload UID（容器内注入；缺省当前用户） */
  workloadUid: number | undefined;
  /** workload GID（容器内注入；缺省当前用户） */
  workloadGid: number | undefined;
  /** 共享工作区回拷属主 UID */
  workspaceOwnerUid: number;
  /** 共享工作区回拷属主 GID */
  workspaceOwnerGid: number;
  /** 执行 grant 签名密钥（compose :? 注入，与 pi-platform 同值） */
  executionGrantSecret: string;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
}

function posNum(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const v = num(env, key, def);
  return v > 0 ? v : def;
}

/** C11：资源型参数护栏——非有限数回退默认；越界 clamp 到 [min,max]（配合 schema 元数据）。 */
function rangeNum(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const v = num(env, key, def);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, v));
}

function posInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const v = Number(env[key]);
  return Number.isInteger(v) && v > 0 ? v : undefined;
}

export function loadSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  return {
    // sandbox 侧默认：kernel-host 自循环（本容器 :8080/kernel/memory-bridge）；
    // src/pth schema 中同键默认是 host/batch 侧 http://localhost:3000/api/v1/kernel/memory-bridge。
    memoryBridge: env.PTH_MEMORY_BRIDGE ?? "http://localhost:8080/kernel/memory-bridge",
    memoryBridgeToken: env.PTH_MEMORY_BRIDGE_TOKEN ?? "",
    kernelPoolSize: rangeNum(env, "PTH_KERNEL_POOL_SIZE", 24, 1, 256),
    kernelAcquireTimeoutMs: posNum(env, "PTH_KERNEL_ACQUIRE_TIMEOUT_MS", 10_000),
    kernelEntryTtlMs: posNum(env, "PTH_KERNEL_ENTRY_TTL_MS", 30 * 60_000),
    compiledCacheDir: env.PTH_COMPILED_CACHE_DIR ?? "/data/compiled-cache/c",
    compiledCacheMaxMb: posNum(env, "PTH_COMPILED_CACHE_MAX_MB", 200),
    compiledMaxCache: posNum(env, "PTH_COMPILED_MAX_CACHE", 50),
    compiledTimeoutMs: posNum(env, "PTH_COMPILED_TIMEOUT_MS", 60_000),
    compiledConcurrency: rangeNum(env, "PTH_COMPILED_CONCURRENCY", 4, 0, 64),
    bridgeUrl: (env.PTH_BRIDGE_URL ?? "http://pi-platform:3000").replace(/\/+$/, ""),
    execPrivateRoot: env.PTH_EXEC_PRIVATE_ROOT,
    debugWorkdir: env.PTH_DEBUG_WORKDIR ?? "/data/workspaces",
    debugIdleMs: posNum(env, "PTH_DEBUG_IDLE_MS", 30 * 60_000),
    debugSessions: rangeNum(env, "PTH_DEBUG_SESSIONS", 4, 1, 64),
    debugSandbox: Boolean(env.PTH_DEBUG_SANDBOX),
    workloadUid: posInt(env, "PTH_WORKLOAD_UID"),
    workloadGid: posInt(env, "PTH_WORKLOAD_GID"),
    workspaceOwnerUid: posNum(env, "PTH_WORKSPACE_OWNER_UID", 1000),
    workspaceOwnerGid: posNum(env, "PTH_WORKSPACE_OWNER_GID", 1000),
    executionGrantSecret: env.PTH_EXECUTION_GRANT_SECRET ?? "",
  };
}
