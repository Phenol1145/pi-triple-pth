/**
 * scripts/eval-n30-runtime-observatory.ts —— N30 运行观测台 provisional evaluator（纯判据 + 开发期自查 CLI）。
 *
 * 定位（plan Task 6 Step 3/4/6）：
 *  - 解析 focused Vitest JSON 报告与 long-run 测试写出的确定性台账；
 *  - 计算精确分母（样本数 / 探针命中数）与 resource/activity/timeline 的 P50/P95/P99；
 *  - 零样本、NaN、缺探针、任何写调用观测 = NO-GO；
 *  - 内置 8 个破坏探针：每个探针只翻转其映射门，用于证明门禁不是空转；
 *  - CLI 跑一次 focused 套件并输出**字节一致**的 JSON 结果（无时间戳/绝对路径/耗时）。
 *
 * 唯一权威验收结论由 `scripts/accept-n30-runtime-observatory.ts` 给出。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ─── 常量合同 ─────────────────────────────────────────────────────────

export const N30_LEDGER_VERSION = "n30-runtime-observatory-ledger/1";

/** focused gate（与计划 Task 6 Step 6 的聚焦命令一致）。 */
export const N30_FOCUSED_TEST_FILES = [
  "test/unit/docker-monitor-*.test.ts",
  "test/pth-contracts/runtime-observation.test.ts",
  "test/pth-application/runtime-observation-facade.pg.test.ts",
  "test/pth-composition/runtime-observatory.integration.test.ts",
  "test/pth-composition/runtime-observatory-long-run.test.ts",
  "test/browser/runtime-observatory.test.ts",
] as const;

/** 健康目标（计划 Global Constraints）：resource P95 ≤5s，activity P95 ≤2s，timeline P95 ≤10s。 */
export const N30_HEALTH_TARGETS = {
  resourceP95Ms: 5000,
  activityP95Ms: 2000,
  timelineP95Ms: 10000,
} as const;

export interface N30Ledger {
  version: string;
  suite: string;
  writeCallsObserved: number;
  resourceLatencyMs: number[];
  activityLatencyMs: number[];
  timelineLatencyMs: number[];
}

// ─── Vitest JSON 报告解析（与 eval-n29 相同的形状合同） ──────────────

export interface VitestAssertion {
  readonly file: string;
  readonly fullName: string;
  readonly title: string;
  readonly status: string;
}

const SKIP_STATUSES = new Set(["pending", "skipped", "todo", "disabled"]);

export function collectVitestAssertions(json: unknown, repoRoot: string): VitestAssertion[] {
  if (typeof json !== "object" || json === null || !Array.isArray((json as { testResults?: unknown }).testResults)) {
    throw new Error("unknown vitest json shape（缺 testResults 数组）");
  }
  const out: VitestAssertion[] = [];
  for (const result of (json as { testResults: Array<{ name?: unknown; assertionResults?: unknown }> }).testResults) {
    if (typeof result.name !== "string" || !Array.isArray(result.assertionResults)) {
      throw new Error("unknown vitest testResult row shape");
    }
    const file = path.relative(repoRoot, result.name).split(path.sep).join("/");
    for (const raw of result.assertionResults as Array<{ fullName?: unknown; title?: unknown; status?: unknown }>) {
      if (typeof raw.status !== "string") throw new Error(`unknown vitest assertion shape in ${file}`);
      out.push({
        file,
        fullName: typeof raw.fullName === "string" ? raw.fullName : "",
        title: typeof raw.title === "string" ? raw.title : "",
        status: raw.status,
      });
    }
  }
  return out;
}

export function summarizeVitest(assertions: readonly VitestAssertion[]): {
  files: number;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
} {
  const files = new Set(assertions.map((a) => a.file));
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const a of assertions) {
    if (a.status === "passed") passed += 1;
    else if (a.status === "failed") failed += 1;
    else if (SKIP_STATUSES.has(a.status)) skipped += 1;
  }
  return { files: files.size, tests: assertions.length, passed, failed, skipped };
}

/** repo-relative、POSIX、按文件名排序的 skip manifest（不解析面向人的 stdout）。 */
export function buildSkipManifest(assertions: readonly VitestAssertion[]): Array<{ file: string; tests: number }> {
  const byFile = new Map<string, number>();
  for (const a of assertions) {
    if (!SKIP_STATUSES.has(a.status)) continue;
    byFile.set(a.file, (byFile.get(a.file) ?? 0) + 1);
  }
  return [...byFile.entries()]
    .filter(([, tests]) => tests > 0)
    .map(([file, tests]) => ({ file, tests }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** 精确文件清单：docker-monitor-*.test.ts 由目录实测展开，杜绝 glob 空转。 */
export function listN30ProbeFiles(repoRoot: string): string[] {
  const unitDir = path.join(repoRoot, "test", "unit");
  const dockerMonitorTests = readdirSync(unitDir)
    .filter((name) => /^docker-monitor-.*\.test\.ts$/.test(name))
    .map((name) => `test/unit/${name}`)
    .sort();
  return [
    ...dockerMonitorTests,
    "test/pth-contracts/runtime-observation.test.ts",
    "test/pth-application/runtime-observation-facade.pg.test.ts",
    "test/pth-composition/runtime-observatory.integration.test.ts",
    "test/pth-composition/runtime-observatory-long-run.test.ts",
    "test/browser/runtime-observatory.test.ts",
  ];
}

// ─── 延迟指标：精确分母 + P50/P95/P99 ─────────────────────────────────

export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * q;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  if (lo === hi) return sorted[lo]!;
  const weight = position - lo;
  return sorted[lo]! * (1 - weight) + sorted[hi]! * weight;
}

export interface LatencyMetrics {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export function computeLatencyMetrics(values: readonly number[]): LatencyMetrics {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    count: values.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

export interface N30Metrics {
  readonly resource: LatencyMetrics;
  readonly activity: LatencyMetrics;
  readonly timeline: LatencyMetrics;
}

// ─── 探针矩阵：每项必须有一条 passed 用例，缺一即 NO-GO ────────────────

export interface RequiredProbe {
  readonly gate: string;
  readonly file: string;
  readonly pattern: RegExp;
}

export const N30_REQUIRED_PROBES: readonly RequiredProbe[] = [
  { gate: "alerts.heartbeat.stale", file: "test/unit/docker-monitor-alerts.test.ts", pattern: /来源 stale → heartbeat\.stale/ },
  { gate: "alerts.heartbeat.dead", file: "test/unit/docker-monitor-alerts.test.ts", pattern: /来源 disconnected → heartbeat\.dead/ },
  { gate: "alerts.queue.backlog", file: "test/unit/docker-monitor-alerts.test.ts", pattern: /queuedTasks 达到阈值 → queue\.backlog/ },
  { gate: "alerts.resource.cpu", file: "test/unit/docker-monitor-alerts.test.ts", pattern: /CPU% 超阈值 → resource\.cpu/ },
  { gate: "alerts.resource.rss", file: "test/unit/docker-monitor-alerts.test.ts", pattern: /RSS 超阈值 → resource\.rss/ },
  { gate: "alerts.task.timeout", file: "test/unit/docker-monitor-alerts.test.ts", pattern: /running 任务超过 taskTimeoutMs → task\.timeout/ },
  { gate: "alerts.stage.stall", file: "test/unit/docker-monitor-alerts.test.ts", pattern: /running intake-run 超过 stageStallMs → stage\.stall/ },
  { gate: "alerts.readonly", file: "test/unit/docker-monitor-alerts.test.ts", pattern: /评估器绝不调用控制 API/ },
  { gate: "ring.bounded", file: "test/pth-composition/runtime-observatory-long-run.test.ts", pattern: /ring 内存：14,400 个样本后只保留 1,800 条，时间轴漂移 ≤ 1 采样周期/ },
  { gate: "sample.bounded", file: "test/pth-composition/runtime-observatory-long-run.test.ts", pattern: /server 采样内存：8 小时 collectOnce 后 sample\/intervals 不随运行时长增长/ },
  { gate: "event.bounded", file: "test/pth-composition/runtime-observatory-long-run.test.ts", pattern: /event 内存：14,400 次 reconcile 后待发事件每次 ≤ 1，不累积/ },
  { gate: "stale.exact", file: "test/pth-composition/runtime-observatory-long-run.test.ts", pattern: /stale 转换发生在精确边界/ },
  { gate: "metrics.nullPreserved", file: "test/unit/docker-monitor-server.test.ts", pattern: /stats 拉取失败时 null metric 保留 null，绝不合成 0/ },
  { gate: "tenant.isolation", file: "test/pth-application/runtime-observation-facade.pg.test.ts", pattern: /tenant A 投影不包含 tenant B 的任何区间/ },
  { gate: "tenant.cursorFailClosed", file: "test/pth-application/runtime-observation-facade.pg.test.ts", pattern: /跨 tenant cursor 一律 fail-closed/ },
  { gate: "browser.credential", file: "test/browser/runtime-observatory.test.ts", pattern: /页面源码与浏览器模块不含 Docker socket 路径或凭据字段/ },
  { gate: "browser.staleHonest", file: "test/browser/runtime-observatory.test.ts", pattern: /stale 状态：来源冻结并灰显，Docker\/PTH 不可用产生降级 banner 数据/ },
  { gate: "charts.sharedScale", file: "test/browser/runtime-observatory.test.ts", pattern: /联动缩放：资源图 brush 反向更新甘特窗口，两个模型共享同一窗口对象/ },
  { gate: "reconcile.authoritative", file: "test/unit/docker-monitor-runtime-aggregator.test.ts", pattern: /snapshot rev1 → 重复\/乱序 delta → 缺 terminal delta → durable rev2 对账后每个 stable ID 只剩一条 revision 2/ },
] as const;

// ─── 门禁上下文与纯判定 ──────────────────────────────────────────────

export interface N30GateContext {
  readonly assertions: readonly VitestAssertion[];
  readonly ledger: N30Ledger | null;
  readonly metrics: N30Metrics;
  readonly probeFiles: readonly string[];
  readonly totals: ReturnType<typeof summarizeVitest>;
}

export interface N30GateResult {
  readonly gate: string;
  readonly ok: boolean;
  readonly reason: string;
}

function hasPassed(assertions: readonly VitestAssertion[], file: string, pattern: RegExp): boolean {
  return assertions.some((a) => a.file === file && pattern.test(a.fullName) && a.status === "passed");
}

function parseLedger(raw: unknown): N30Ledger | null {
  if (typeof raw !== "object" || raw === null) return null;
  const l = raw as Record<string, unknown>;
  if (l["version"] !== N30_LEDGER_VERSION) return null;
  if (l["suite"] !== "runtime-observatory-long-run") return null;
  if (!Array.isArray(l["resourceLatencyMs"]) || !Array.isArray(l["activityLatencyMs"]) || !Array.isArray(l["timelineLatencyMs"])) return null;
  if (typeof l["writeCallsObserved"] !== "number" || !Number.isFinite(l["writeCallsObserved"])) return null;
  return {
    version: l["version"] as string,
    suite: l["suite"] as string,
    writeCallsObserved: l["writeCallsObserved"] as number,
    resourceLatencyMs: l["resourceLatencyMs"] as number[],
    activityLatencyMs: l["activityLatencyMs"] as number[],
    timelineLatencyMs: l["timelineLatencyMs"] as number[],
  };
}

export function computeN30Metrics(ledger: N30Ledger | null): N30Metrics {
  return {
    resource: computeLatencyMetrics(ledger?.resourceLatencyMs ?? []),
    activity: computeLatencyMetrics(ledger?.activityLatencyMs ?? []),
    timeline: computeLatencyMetrics(ledger?.timelineLatencyMs ?? []),
  };
}

export function makeN30GateContext(input: {
  assertions: readonly VitestAssertion[];
  ledger: unknown;
  probeFiles: readonly string[];
}): N30GateContext {
  const totals = summarizeVitest(input.assertions);
  const ledger = parseLedger(input.ledger);
  const metrics = computeN30Metrics(ledger);
  return { assertions: input.assertions, ledger, metrics, probeFiles: input.probeFiles, totals };
}

export function evaluateN30Gates(ctx: N30GateContext): N30GateResult[] {
  const gates: N30GateResult[] = [];

  gates.push({
    gate: "report.no-failed",
    ok: ctx.totals.failed === 0,
    reason: ctx.totals.failed === 0 ? "no failed tests" : `failed tests=${ctx.totals.failed}`,
  });
  gates.push({
    gate: "report.no-skipped",
    ok: ctx.totals.skipped === 0,
    reason: ctx.totals.skipped === 0 ? "no skipped tests" : `skipped tests=${ctx.totals.skipped}`,
  });

  for (const file of ctx.probeFiles) {
    const passed = ctx.assertions.filter((a) => a.file === file && a.status === "passed").length;
    const failed = ctx.assertions.filter((a) => a.file === file && a.status === "failed").length;
    gates.push({
      gate: `probe.file:${file}`,
      ok: passed > 0 && failed === 0,
      reason: passed === 0 ? `file not run or 0 passed: ${file}` : `failed=${failed} in ${file}`,
    });
  }

  for (const probe of N30_REQUIRED_PROBES) {
    const ok = hasPassed(ctx.assertions, probe.file, probe.pattern);
    gates.push({
      gate: `probe.${probe.gate}`,
      ok,
      reason: ok ? "passed" : `missing passed probe: ${probe.file}::${String(probe.pattern)}`,
    });
  }

  const ledgerOk = ctx.ledger !== null;
  gates.push({
    gate: "ledger.valid",
    ok: ledgerOk,
    reason: ledgerOk ? `ledger version ${N30_LEDGER_VERSION}` : "ledger missing or invalid",
  });

  const sampleOk = ctx.metrics.resource.count > 0 && ctx.metrics.activity.count > 0 && ctx.metrics.timeline.count > 0;
  gates.push({
    gate: "ledger.latency-samples",
    ok: sampleOk,
    reason: sampleOk
      ? `samples resource=${ctx.metrics.resource.count} activity=${ctx.metrics.activity.count} timeline=${ctx.metrics.timeline.count}`
      : `zero samples resource=${ctx.metrics.resource.count} activity=${ctx.metrics.activity.count} timeline=${ctx.metrics.timeline.count}`,
  });

  const finiteOk = [
    ctx.metrics.resource,
    ctx.metrics.activity,
    ctx.metrics.timeline,
  ].every((m) => [m.p50, m.p95, m.p99].every(Number.isFinite));
  gates.push({
    gate: "ledger.latency-finite",
    ok: finiteOk,
    reason: finiteOk ? "all percentiles finite" : "NaN percentile detected",
  });

  const targetOk =
    ctx.metrics.resource.p95 <= N30_HEALTH_TARGETS.resourceP95Ms &&
    ctx.metrics.activity.p95 <= N30_HEALTH_TARGETS.activityP95Ms &&
    ctx.metrics.timeline.p95 <= N30_HEALTH_TARGETS.timelineP95Ms;
  gates.push({
    gate: "latency.targets",
    ok: targetOk,
    reason: targetOk
      ? `P95 resource=${ctx.metrics.resource.p95}≤${N30_HEALTH_TARGETS.resourceP95Ms} activity=${ctx.metrics.activity.p95}≤${N30_HEALTH_TARGETS.activityP95Ms} timeline=${ctx.metrics.timeline.p95}≤${N30_HEALTH_TARGETS.timelineP95Ms}`
      : `P95 target exceeded: resource=${ctx.metrics.resource.p95} activity=${ctx.metrics.activity.p95} timeline=${ctx.metrics.timeline.p95}`,
  });

  const writeOk = (ctx.ledger?.writeCallsObserved ?? 0) === 0;
  gates.push({
    gate: "alerts.write-calls",
    ok: writeOk,
    reason: writeOk ? "writeCallsObserved=0" : `writeCallsObserved=${ctx.ledger?.writeCallsObserved}`,
  });

  return gates;
}

export interface N30EvaluatorResult {
  readonly decision: "PASS" | "FAIL";
  readonly totals: ReturnType<typeof summarizeVitest>;
  readonly metrics: N30Metrics;
  readonly gates: readonly N30GateResult[];
  readonly reasons: readonly string[];
}

export function evaluateN30Observatory(ctx: N30GateContext): N30EvaluatorResult {
  const gates = evaluateN30Gates(ctx);
  const reasons = gates.filter((g) => !g.ok).map((g) => `${g.gate}: ${g.reason}`);
  return { decision: reasons.length === 0 ? "PASS" : "FAIL", totals: ctx.totals, metrics: ctx.metrics, gates, reasons };
}

// ─── 破坏探针：每边界一个，只翻转其映射门 ──────────────────────────────

export interface N30SabotageProbe {
  readonly gate: string;
  readonly mutate: (ctx: N30GateContext) => N30GateContext;
}

function removePassedProbe(ctx: N30GateContext, file: string, pattern: RegExp): N30GateContext {
  return {
    ...ctx,
    assertions: ctx.assertions.filter((a) => !(a.file === file && pattern.test(a.fullName) && a.status === "passed")),
    totals: summarizeVitest(ctx.assertions.filter((a) => !(a.file === file && pattern.test(a.fullName) && a.status === "passed"))),
  };
}

export const N30_SABOTAGE_PROBES: readonly N30SabotageProbe[] = [
  { gate: "probe.ring.bounded", mutate: (ctx) => removePassedProbe(ctx, "test/pth-composition/runtime-observatory-long-run.test.ts", /ring 内存：14,400 个样本后只保留 1,800 条/) },
  { gate: "probe.metrics.nullPreserved", mutate: (ctx) => removePassedProbe(ctx, "test/unit/docker-monitor-server.test.ts", /stats 拉取失败时 null metric 保留 null/) },
  { gate: "probe.tenant.isolation", mutate: (ctx) => removePassedProbe(ctx, "test/pth-application/runtime-observation-facade.pg.test.ts", /tenant A 投影不包含 tenant B 的任何区间/) },
  { gate: "probe.browser.credential", mutate: (ctx) => removePassedProbe(ctx, "test/browser/runtime-observatory.test.ts", /页面源码与浏览器模块不含 Docker socket 路径或凭据字段/) },
  { gate: "probe.reconcile.authoritative", mutate: (ctx) => removePassedProbe(ctx, "test/unit/docker-monitor-runtime-aggregator.test.ts", /snapshot rev1 → 重复\/乱序 delta/) },
  { gate: "probe.browser.staleHonest", mutate: (ctx) => removePassedProbe(ctx, "test/browser/runtime-observatory.test.ts", /stale 状态：来源冻结并灰显/) },
  { gate: "probe.charts.sharedScale", mutate: (ctx) => removePassedProbe(ctx, "test/browser/runtime-observatory.test.ts", /联动缩放：资源图 brush 反向更新甘特窗口/) },
  { gate: "alerts.write-calls", mutate: (ctx) => ({ ...ctx, ledger: ctx.ledger ? { ...ctx.ledger, writeCallsObserved: 1 } : ctx.ledger }) },
];

export interface N30SabotageResult {
  readonly gate: string;
  readonly baseOk: boolean;
  readonly sabotagedOk: boolean;
  readonly flipped: boolean;
}

export function runN30SabotageProbes(ctx: N30GateContext): N30SabotageResult[] {
  const baseGates = evaluateN30Gates(ctx);
  const baseByName = new Map(baseGates.map((g) => [g.gate, g]));
  const results: N30SabotageResult[] = [];
  for (const probe of N30_SABOTAGE_PROBES) {
    const base = baseByName.get(probe.gate);
    const mutatedGates = evaluateN30Gates(probe.mutate(ctx));
    const sabotaged = mutatedGates.find((g) => g.gate === probe.gate);
    const sabotagedOk = sabotaged?.ok ?? false;
    results.push({
      gate: probe.gate,
      baseOk: base?.ok ?? false,
      sabotagedOk,
      flipped: sabotagedOk === false,
    });
  }
  return results;
}

// ─── CLI（开发期自查；权威结论在 accept driver） ───────────────────────

function dockerAvailable(): boolean {
  const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 15_000 });
  return docker.status === 0;
}

function gitHead(repoRoot: string): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
}

export interface N30CliOutput {
  readonly schema: string;
  readonly decision: "PASS" | "FAIL" | "ENVIRONMENT-UNAVAILABLE";
  readonly evaluatedCommit: string;
  readonly totals: ReturnType<typeof summarizeVitest> | null;
  readonly metrics: N30Metrics | null;
  readonly gates: readonly N30GateResult[] | null;
  readonly sabotage: readonly N30SabotageResult[] | null;
  readonly reasons: readonly string[];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.cwd();
  if (!dockerAvailable()) {
    const out: N30CliOutput = {
      schema: "n30-runtime-observatory-eval/1",
      decision: "ENVIRONMENT-UNAVAILABLE",
      evaluatedCommit: gitHead(repoRoot),
      totals: null,
      metrics: null,
      gates: null,
      sabotage: null,
      reasons: ["docker/postgres 不可用（focused 套件含 testcontainers PostgreSQL）"],
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exitCode = 2;
  } else {
    const dir = mkdtempSync(path.join(tmpdir(), "n30-eval-"));
    const reportPath = path.join(dir, "focused.json");
    const ledgerPath = path.join(dir, "ledger.json");
    const currentHead = gitHead(repoRoot);

    const run = spawnSync(
      `npx vitest run ${N30_FOCUSED_TEST_FILES.join(" ")} --reporter=json --outputFile ${reportPath} --hookTimeout 60000 --testTimeout 120000`,
      {
        shell: true,
        encoding: "utf8",
        cwd: repoRoot,
        timeout: 3_600_000,
        env: { ...process.env, N30_RUNTIME_OBSERVATORY_LEDGER: ledgerPath },
      },
    );

    let assertions: VitestAssertion[] = [];
    try {
      assertions = collectVitestAssertions(JSON.parse(readFileSync(reportPath, "utf8")), repoRoot);
    } catch {
      // 报告不可解析 → 下方 gates 会给出结构化 FAIL（probe files 全部缺失）。
    }
    let ledgerRaw: unknown = null;
    try {
      ledgerRaw = JSON.parse(readFileSync(ledgerPath, "utf8"));
    } catch {
      // 台账缺失 → parseLedger 返回 null，由 ledger.valid gate 判 FAIL。
    }

    const ctx = makeN30GateContext({
      assertions,
      ledger: ledgerRaw,
      probeFiles: listN30ProbeFiles(repoRoot),
    });
    const result = evaluateN30Observatory(ctx);
    const sabotage = runN30SabotageProbes(ctx);
    const sabotageMisses = sabotage.filter((s) => !s.flipped);

    const reasons = [...result.reasons];
    for (const miss of sabotageMisses) {
      reasons.push(`sabotage probe ${miss.gate} did not flip (sabotagedOk=${String(miss.sabotagedOk)})`);
    }
    const decision = reasons.length === 0 ? "PASS" : "FAIL";

    const out: N30CliOutput = {
      schema: "n30-runtime-observatory-eval/1",
      decision,
      evaluatedCommit: currentHead,
      totals: result.totals,
      metrics: result.metrics,
      gates: result.gates,
      sabotage,
      reasons,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = decision === "PASS" ? 0 : 1;
  }
}
