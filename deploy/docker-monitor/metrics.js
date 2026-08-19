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

/**
 * 解析 Docker inspect 的 RFC3339 时间戳（UTC epoch ms）。
 * Docker 未启动/未结束字段是零值 "0001-01-01T00:00:00Z"——按 null 处理。
 * @param {string | undefined | null} value
 * @returns {number | null}
 */
export function parseDockerTime(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.startsWith("0001-01-01")) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * 容器 inspect + 列表条目 → service RuntimeInterval（Docker 侧）。
 *
 * 区间身份 = Docker ID + startAt：同一容器重启后 startAt 变化，形成新 revision。
 * 运行中 endAt=null；已退出 endAt=FinishedAt（无 FinishedAt 则 null）。
 *
 * @param {Record<string, unknown>} container  /containers/json 条目
 * @param {Record<string, unknown> | null} inspect /containers/:id/json 结果
 * @param {{now: number, expectedIntervalMs: number}} ctx
 */
export function buildContainerInterval(container, inspect, { now, expectedIntervalMs }) {
  const id = inspect?.Id ?? container?.Id ?? "?";
  const name = (inspect?.Name ?? container?.Names?.[0] ?? "").replace(/^\//, "");
  const image = (inspect?.Config?.Image ?? container?.Image ?? "").split("@")[0];

  const createdMs = parseDockerTime(inspect?.Created);
  const startedMs = parseDockerTime(inspect?.State?.StartedAt);
  const finishedMs = parseDockerTime(inspect?.State?.FinishedAt);
  const running = inspect?.State?.Running ?? container?.State === "running";

  // 未启动的容器没有 StartedAt：用 Created 作为服务区间起点
  const startAt = startedMs ?? createdMs ?? now;
  const endAt = running ? null : finishedMs;

  let status = "unknown";
  if (running) status = "running";
  else if (endAt !== null) status = inspect?.State?.ExitCode === 0 ? "completed" : "failed";

  const staleAfterMs = Math.max(3 * expectedIntervalMs, 6000);

  return {
    id: `service:${id}:${startAt}`,
    kind: "service",
    label: name || id.slice(0, 12),
    image,
    status,
    sourceVersion: `${startAt}`,
    startAt,
    endAt,
    freshness: {
      sourceObservedAt: now,
      collectedAt: now,
      expectedIntervalMs,
      staleAfterMs,
    },
  };
}
