/**
 * scripts/accept-n30-runtime-observatory.ts —— N30 运行观测台唯一验收权威（plan Task 6 Step 5）。
 *
 * 它在同一个 clean evaluatedCommit 上收集并绑定：
 *   evaluatedCommit / 工作树 clean / focused / full / lint / build /
 *   real Docker+PTH composition / long-run / browser / skip manifest /
 *   精确分母 + P50/P95/P99 + 破坏探针翻转矩阵，
 * 然后给出唯一 envelope：`GO | NO-GO | EVALUATION-INCOMPLETE`。
 *
 * 判定优先级（计划 Task 6 Step 5）：
 *  1. 任何**已启动**门禁非零退出、commit 不符、工作树脏、focused 出现 skip、
 *     full skip manifest 与冻结清单不一致、评估器非 PASS、破坏探针未翻转 → NO-GO；
 *     NO-GO 不得被"后续环境不可用"覆盖。
 *  2. 门禁在启动前环境不可用（toolchain / docker）→ EVALUATION-INCOMPLETE。
 *  3. 全部成立才允许 GO（仅代表 N30 运行观测台，不代表 N33 嵌入或 O5 自助服务）。
 *
 * 进程退出码：0 = GO，1 = NO-GO，2 = EVALUATION-INCOMPLETE。
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildSkipManifest,
  collectVitestAssertions,
  evaluateN30Observatory,
  listN30ProbeFiles,
  makeN30GateContext,
  N30_FOCUSED_TEST_FILES,
  runN30SabotageProbes,
  summarizeVitest,
  type N30EvaluatorResult,
  type N30SabotageResult,
  type VitestAssertion,
} from "./eval-n30-runtime-observatory.js";

export const N30_ENVELOPE_SCHEMA = "n30-runtime-observatory-acceptance/1";

export const N30_DISCLAIMER =
  "This result validates the local runtime observatory (N30 O0–O4) only: Docker sampling, tenant-scoped durable PTH timeline projection, server-side aggregation/freshness, C-layout Gantt/resource charts, read-only alerts, bounded long-run memory and sabotage sensitivity. It does not validate N33 embedment, O5 tenant self-service, long-term history retention, or any control-plane write path.";

/** full regression 允许的既有冻结 skip（由最近一次全量实测冻结；新 skip 一律 NO-GO）。 */
export const N30_ACCEPTED_FULL_SKIPS: readonly { file: string; tests: number }[] = [
  { file: "test/pth-execution/sandbox-security.integration.test.ts", tests: 9 },
];

// ─── 门禁证据 ─────────────────────────────────────────────────────────

export type UnavailableReason = "toolchain" | "docker";

export interface CommandGateEvidence {
  command: string;
  started: boolean;
  exitCode: number | null;
  durationMs: number | null;
  skipped: readonly { file: string; tests: number }[];
  environmentStatus: "available" | "unavailable";
  unavailableReason?: UnavailableReason;
  totals?: { files: number; tests: number; passed: number; failed: number; skipped: number };
  stdoutTail?: string;
  stderrTail?: string;
}

export interface RealismGateEvidence {
  readonly gate: string;
  readonly requirement: string;
  readonly status: "satisfied" | "not-executed";
  readonly evidence: string;
}

export interface N30AcceptanceEnvelope {
  schema: string;
  generatedAt: string;
  plan: string;
  evaluatedCommit: string;
  implementationTreeClean: boolean;
  evaluator: N30EvaluatorResult;
  focused: CommandGateEvidence;
  full: CommandGateEvidence;
  lint: CommandGateEvidence;
  build: CommandGateEvidence;
  sabotage: readonly N30SabotageResult[];
  realismGates: readonly RealismGateEvidence[];
  decision: "GO" | "NO-GO" | "EVALUATION-INCOMPLETE";
  reasons: readonly string[];
  disclaimer: string;
}

const GATE_ORDER = ["focused", "full", "lint", "build"] as const;
type GateName = (typeof GATE_ORDER)[number];

function gatesOf(envelope: N30AcceptanceEnvelope): Array<[GateName, CommandGateEvidence]> {
  return GATE_ORDER.map((name) => [name, envelope[name]] as [GateName, CommandGateEvidence]);
}

// ─── 纯判定（可单测；不执行任何命令） ───────────────────────────────────

export interface DecisionOutcome {
  readonly decision: N30AcceptanceEnvelope["decision"];
  readonly reasons: readonly string[];
}

export function decideN30Acceptance(
  envelope: N30AcceptanceEnvelope,
  opts: { currentHead: string },
): DecisionOutcome {
  const noGo: string[] = [];
  const incomplete: string[] = [];

  if (!envelope.evaluatedCommit || envelope.evaluatedCommit !== opts.currentHead) {
    noGo.push(`evaluatedCommit=${envelope.evaluatedCommit || "(空)"} != HEAD=${opts.currentHead || "(空)"}`);
  }
  if (!envelope.implementationTreeClean) noGo.push("implementation tree not clean");

  for (const [name, gate] of gatesOf(envelope)) {
    if (gate.environmentStatus === "unavailable" || !gate.started) {
      incomplete.push(`${name}: not started（${gate.unavailableReason ?? "unknown"}）`);
      continue;
    }
    if (gate.exitCode !== 0) noGo.push(`${name}: exit=${String(gate.exitCode)}`);
  }

  if (envelope.focused.started && envelope.focused.exitCode === 0 && envelope.focused.skipped.length > 0) {
    noGo.push(`focused: unexpected skips ${JSON.stringify(envelope.focused.skipped)}`);
  }
  if (envelope.full.started && envelope.full.exitCode === 0) {
    const expected = JSON.stringify(N30_ACCEPTED_FULL_SKIPS.map((s) => ({ ...s })));
    const actual = JSON.stringify(envelope.full.skipped.map((s) => ({ ...s })));
    if (actual !== expected) noGo.push(`full skip manifest changed: ${actual}`);
  }

  if (envelope.focused.started) {
    if (envelope.evaluator.decision !== "PASS") {
      for (const reason of envelope.evaluator.reasons) noGo.push(`evaluator: ${reason}`);
      if (envelope.evaluator.reasons.length === 0) noGo.push("evaluator: FAIL without reason");
    }
    for (const probe of envelope.sabotage) {
      if (!probe.flipped) noGo.push(`sabotage probe ${probe.gate} did not flip`);
    }
  }

  for (const gate of envelope.realismGates) {
    if (gate.status !== "satisfied") incomplete.push(`realism ${gate.gate} (${gate.status}): ${gate.evidence}`);
  }

  if (noGo.length > 0) return { decision: "NO-GO", reasons: [...noGo, ...incomplete] };
  if (incomplete.length > 0) return { decision: "EVALUATION-INCOMPLETE", reasons: incomplete };
  return { decision: "GO", reasons: [] };
}

// ─── 真实性/组合证据（只从 focused 报告 passed 用例取证） ──────────────

function passedTitle(assertions: readonly VitestAssertion[], file: string, pattern: RegExp): boolean {
  return assertions.some((a) => a.file === file && pattern.test(a.fullName) && a.status === "passed");
}

export function deriveN30RealismGates(assertions: readonly VitestAssertion[]): RealismGateEvidence[] {
  const dockerComposition = passedTitle(
    assertions,
    "test/pth-composition/runtime-observatory.integration.test.ts",
    /monitor \/snapshot 合并真实 PG durable timeline/,
  );
  const longRun = passedTitle(
    assertions,
    "test/pth-composition/runtime-observatory-long-run.test.ts",
    /ring 内存：14,400 个样本后只保留 1,800 条/,
  );
  const browser = passedTitle(
    assertions,
    "test/browser/runtime-observatory.test.ts",
    /页面源码与浏览器模块不含 Docker socket 路径或凭据字段/,
  );

  return [
    {
      gate: "real-docker-pth-composition",
      requirement: "真实 testcontainers PostgreSQL + 最小 PTH gateway + docker-monitor 聚合（monitor /snapshot 合并 durable timeline）",
      status: dockerComposition ? "satisfied" : "not-executed",
      evidence: dockerComposition
        ? "test/pth-composition/runtime-observatory.integration.test.ts::monitor /snapshot 合并真实 PG durable timeline，且 pth-timeline fresh = passed"
        : "未在 focused 报告中观察到真实 Docker+PTH 组合用例（docker 缺失会使该套件无法启动）",
    },
    {
      gate: "long-run-bounded-memory",
      requirement: "假时钟推进 14,400 个 2 秒样本，ring/sample/event 内存低于固定上限，stale 边界精确，时间轴漂移 ≤1 采样周期",
      status: longRun ? "satisfied" : "not-executed",
      evidence: longRun
        ? "test/pth-composition/runtime-observatory-long-run.test.ts::ring 内存 14,400 样本 = passed（含 8 小时 server 采样、event 内存、stale 精确边界）"
        : "未在 focused 报告中观察到 long-run 用例",
    },
    {
      gate: "browser-credential-boundary",
      requirement: "浏览器载荷/页面源码/本地存储不含 Docker socket 路径或 PTH 凭据字段",
      status: browser ? "satisfied" : "not-executed",
      evidence: browser
        ? "test/browser/runtime-observatory.test.ts::页面源码与浏览器模块不含 Docker socket 路径或凭据字段 = passed"
        : "未在 focused 报告中观察到浏览器凭据边界用例",
    },
  ];
}

// ─── 环境探测与命令执行 ────────────────────────────────────────────────

interface Probe {
  readonly kind: UnavailableReason;
  readonly ok: boolean;
  readonly detail: string;
}

export function preflight(): Probe[] {
  const probes: Probe[] = [];
  const node = spawnSync("node", ["--version"], { encoding: "utf8" });
  const npm = spawnSync("npm", ["--version"], { encoding: "utf8" });
  const npx = spawnSync("npx", ["--version"], { encoding: "utf8" });
  probes.push({
    kind: "toolchain",
    ok: node.status === 0 && npm.status === 0 && npx.status === 0,
    detail: `node=${(node.stdout ?? "").trim()} npm=${(npm.stdout ?? "").trim()} npx=${(npx.stdout ?? "").trim()}`,
  });
  const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 20_000 });
  probes.push({
    kind: "docker",
    ok: docker.status === 0,
    detail: `docker(Testcontainers PostgreSQL) → ${(docker.stdout ?? docker.stderr ?? "").trim().slice(0, 160)}`,
  });
  return probes;
}

function tail(text: string | null | undefined, max = 6_000): string {
  const value = text ?? "";
  return value.length > max ? value.slice(value.length - max) : value;
}

export function runGate(
  command: string,
  opts: {
    cwd: string;
    env?: Record<string, string>;
    unavailableReason?: UnavailableReason;
    timeoutMs?: number;
  },
): CommandGateEvidence {
  if (opts.unavailableReason) {
    return {
      command,
      started: false,
      exitCode: null,
      durationMs: null,
      skipped: [],
      environmentStatus: "unavailable",
      unavailableReason: opts.unavailableReason,
    };
  }
  const startedAt = Date.now();
  const run = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 3_600_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return {
    command,
    started: true,
    exitCode: run.status,
    durationMs: Date.now() - startedAt,
    skipped: [],
    environmentStatus: "available",
    stdoutTail: tail(run.stdout),
    stderrTail: tail(run.stderr),
  };
}

function gitHead(repoRoot: string): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
}

function treeClean(repoRoot: string): boolean {
  return spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim() === "";
}

// ─── 采集 ─────────────────────────────────────────────────────────────

export async function collect(repoRoot: string, output?: string): Promise<N30AcceptanceEnvelope> {
  const currentHead = gitHead(repoRoot);
  const cleanBefore = treeClean(repoRoot);
  const probes = preflight();
  const unavailable = (kind: UnavailableReason): UnavailableReason | undefined =>
    probes.find((p) => p.kind === kind)?.ok ? undefined : kind;

  const dir = await mkdtemp(path.join(tmpdir(), "n30-accept-"));
  const focusedJson = path.join(dir, "focused.json");
  const fullJson = path.join(dir, "full.json");
  const ledgerPath = path.join(dir, "ledger.json");

  const focusedCommand = `npx vitest run ${N30_FOCUSED_TEST_FILES.join(" ")} --reporter=json --outputFile ${focusedJson} --hookTimeout 60000 --testTimeout 120000`;
  const focused = runGate(focusedCommand, {
    cwd: repoRoot,
    env: { N30_RUNTIME_OBSERVATORY_LEDGER: ledgerPath },
    unavailableReason: unavailable("toolchain") ?? unavailable("docker"),
    timeoutMs: 3_600_000,
  });
  const full = runGate(`npm test -- --reporter=json --outputFile ${fullJson} --hookTimeout 60000`, {
    cwd: repoRoot,
    unavailableReason: unavailable("toolchain") ?? unavailable("docker"),
    timeoutMs: 5_400_000,
  });
  const lint = runGate("npm run lint", {
    cwd: repoRoot,
    unavailableReason: unavailable("toolchain"),
    timeoutMs: 900_000,
  });
  const build = runGate("npm run build", {
    cwd: repoRoot,
    unavailableReason: unavailable("toolchain"),
    timeoutMs: 1_800_000,
  });

  let focusedAssertions: VitestAssertion[] = [];
  if (focused.started) {
    try {
      focusedAssertions = collectVitestAssertions(JSON.parse(await readFile(focusedJson, "utf8")), repoRoot);
      focused.skipped = buildSkipManifest(focusedAssertions);
      focused.totals = summarizeVitest(focusedAssertions);
    } catch (error) {
      focused.stderrTail = `${focused.stderrTail ?? ""}\n[driver] focused JSON 报告不可解析：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (full.started) {
    try {
      const fullAssertions = collectVitestAssertions(JSON.parse(await readFile(fullJson, "utf8")), repoRoot);
      full.skipped = buildSkipManifest(fullAssertions);
      full.totals = summarizeVitest(fullAssertions);
    } catch (error) {
      full.stderrTail = `${full.stderrTail ?? ""}\n[driver] full JSON 报告不可解析：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  let ledgerRaw: unknown = null;
  try {
    ledgerRaw = JSON.parse(await readFile(ledgerPath, "utf8"));
  } catch { /* 台账缺失 → evaluator 给出结构化 FAIL 原因 */ }

  const ctx = makeN30GateContext({
    assertions: focusedAssertions,
    ledger: ledgerRaw,
    probeFiles: listN30ProbeFiles(repoRoot),
  });
  const evaluator = evaluateN30Observatory(ctx);
  const sabotage = runN30SabotageProbes(ctx);

  const envelope: N30AcceptanceEnvelope = {
    schema: N30_ENVELOPE_SCHEMA,
    generatedAt: new Date().toISOString(),
    plan: "docs/superpowers/plans/2026-08-19-n30-runtime-observatory.md",
    evaluatedCommit: currentHead,
    implementationTreeClean: cleanBefore && treeClean(repoRoot),
    evaluator,
    focused,
    full,
    lint,
    build,
    sabotage,
    realismGates: deriveN30RealismGates(focusedAssertions),
    decision: "EVALUATION-INCOMPLETE",
    reasons: [],
    disclaimer: N30_DISCLAIMER,
  };

  const outcome = decideN30Acceptance(envelope, { currentHead });
  envelope.decision = outcome.decision;
  envelope.reasons = [
    ...outcome.reasons,
    ...probes.filter((p) => !p.ok).map((p) => `preflight ${p.kind}: ${p.detail}`),
  ];

  await rm(dir, { recursive: true, force: true });
  const text = `${JSON.stringify(envelope, null, 2)}\n`;
  if (output) await writeFile(path.resolve(repoRoot, output), text, "utf8");
  else process.stdout.write(text);
  return envelope;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  const repoRoot = process.cwd();
  const envelope = await collect(repoRoot, output);
  process.stderr.write(
    `[accept-n30] decision=${envelope.decision} commit=${envelope.evaluatedCommit} reasons=${envelope.reasons.length}\n`,
  );
  process.exitCode = envelope.decision === "GO" ? 0 : envelope.decision === "NO-GO" ? 1 : 2;
}
