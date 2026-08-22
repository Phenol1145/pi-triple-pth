/**
 * kernel-config —— 多语言 kernel 参数化配置（仿 PG 参数模式，环境变量可调）。
 *
 * 参数（所有可 env 覆盖，生产/试运行/容器部署同源）：
 *   PTH_KERNEL_LAZY_SPAWN    默认 1  → 懒 spawn：构造不起进程，首次 execute 才 spawn
 *   PTH_KERNEL_IDLE_MS       默认 300000（5min）→ 空闲回收：无调用超时 kill（0=禁用）
 *   PTH_KERNEL_RESET_MODE    默认 ns → reset 语义：ns=清命名空间不重启（python）；
 *                                          restart=杀进程重启（bash 默认，spawn 便宜）
 *   （预留）PTH_KERNEL_POOL_SIZE 默认 0 → 0=per-worker；N=共享池大小（池化 v2 落地时启用）
 */
export interface KernelConfig {
  lazySpawn: boolean;
  idleMs: number;
  resetMode: "ns" | "restart";
}

const DEFAULTS: KernelConfig = {
  lazySpawn: true,
  idleMs: 300_000,
  resetMode: "ns",
};

export function loadKernelConfig(env: NodeJS.ProcessEnv = process.env): KernelConfig {
  const idle = Number(env.PTH_KERNEL_IDLE_MS ?? DEFAULTS.idleMs);
  return {
    lazySpawn: env.PTH_KERNEL_LAZY_SPAWN !== "0",
    idleMs: Number.isFinite(idle) && idle >= 0 ? idle : DEFAULTS.idleMs,
    resetMode: env.PTH_KERNEL_RESET_MODE === "restart" ? "restart" : "ns",
  };
}
