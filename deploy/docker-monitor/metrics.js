/**
 * Docker stats 快照 → 监控指标（纯函数——可单测）。
 * CPU% 计算：stats 的 cpu_stats 是累计值，需两帧差（Δtotal / Δsystem × onlineCpus × 100）。
 * 单帧无法算 CPU%——本函数接收 prev 快照做差值；无 prev 时 cpuPct=null（下一帧补）。
 */

/**
 * @param {Record<string, unknown>} raw  docker stats 快照
 * @param {string} _id                 （保留位）
 * @param {Record<string, unknown>} [prev] 上一帧快照（算 CPU% 差值用）
 * @returns {{cpuPct: number|null, memUsage: number, memLimit: number, memPct: number|null, netRx: number, netTx: number}}
 */
export function computeMetrics(raw, _id, prev) {
  const cpu = raw.cpu_stats ?? {};
  const mem = raw.memory_stats ?? {};

  const memUsage = mem.usage ?? 0;
  const memLimit = mem.limit ?? 0;
  const memPct = memLimit > 0 ? (memUsage / memLimit) * 100 : null;

  // 网络（多网卡求和）——Docker API 字段为 snake_case（rx_bytes/tx_bytes）
  let netRx = 0;
  let netTx = 0;
  const nets = raw.networks;
  if (nets) {
    for (const v of Object.values(nets)) {
      netRx += v?.rx_bytes ?? 0;
      netTx += v?.tx_bytes ?? 0;
    }
  }

  // CPU%：需要与上一帧做差——Docker API 字段为 snake_case（cpu_usage.total_usage/system_cpu_usage/online_cpus）
  let cpuPct = null;
  const prevCpu = prev ? prev.cpu_stats : undefined;
  const prevTotal = prevCpu?.cpu_usage?.total_usage;
  const prevSystem = prevCpu?.system_cpu_usage;
  const total = cpu.cpu_usage?.total_usage;
  const system = cpu.system_cpu_usage;
  const onlineCpus = cpu.online_cpus ?? 1;
  if (prevTotal !== undefined && prevSystem !== undefined && total !== undefined && system !== undefined) {
    const dt = total - prevTotal;
    const ds = system - prevSystem;
    if (ds > 0 && dt >= 0) {
      cpuPct = (dt / ds) * onlineCpus * 100;
    }
  }

  return { cpuPct, memUsage, memLimit, memPct, netRx, netTx };
}
