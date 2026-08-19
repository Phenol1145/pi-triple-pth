/**
 * scripts/accept-n29-minimal-intake.ts —— N29 最小可信摄入内环唯一验收权威（计划 §5 Task 7）。
 *
 * 它在**同一个 clean evaluatedCommit** 上收集并绑定：
 *   evaluatedCommit / 工作树 clean / Trust Policy digest / 各门禁命令与 exit code /
 *   Vitest JSON 报告派生的 skip manifest / 正向分母台账 / 负向 sentinel 矩阵 / 真实性门禁处置，
 * 然后给出唯一 envelope：`MIN_INNER_LOOP_GO | NO-GO | EVALUATION-INCOMPLETE`。
 *
 * 判定优先级（计划 §5 Task 7 Step 5）：
 *  1. 任何**已启动**门禁非零退出、分母缺失/NaN/零、sentinel 命中 0、commit 不符或工作树脏 → NO-GO；
 *     NO-GO 不得被"后续环境不可用"覆盖。
 *  2. 门禁在启动前环境不可用，或真实性门禁（受控 TLS 全链路 / release canary / 双 OS 进程 /
 *     SIGKILL 重启 / G10 敏感度）未执行 → EVALUATION-INCOMPLETE。
 *  3. 全部成立才允许 MIN_INNER_LOOP_GO（且仅代表最小内环，不代表 N26 完整双环）。
 *
 * 进程退出码：0 = MIN_INNER_LOOP_GO，1 = NO-GO，2 = EVALUATION-INCOMPLETE。
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildSkipManifest,
  checkDenominators,
  collectVitestAssertions,
  deriveNegativeSentinels,
  evaluateN29Ledger,
  N29_ACCEPTED_FULL_SKIPS,
  N29_FOCUSED_TEST_FILES,
  N29_REQUIRED_LEDGER_NEGATIVES,
  N29_REQUIRED_POSITIVES,
  summarizeVitest,
  type DenominatorRow,
  type N29EvaluatorResult,
  type SentinelEvidence,
  type VitestAssertion,
} from "./eval-n29-minimal-intake.js";

export const N29_ENVELOPE_SCHEMA = "n29-minimal-intake-acceptance/1";

export const N29_DISCLAIMER =
  "This result validates the minimal single-source trusted intake inner loop only (one human-signed Trust Policy, one tenant/space/domain/subscription, one bounded HTTPS/HTML connector, initial + unchanged + changed recrawl). It does not validate source discovery/expansion, multi-source conflict resolution, multi-domain or ten-domain breadth, automatic partitioning/rebalancing/autoscaling, external object storage or vector indexing, browser-rendered or authenticated connectors, or real-LLM extraction quality.";

// ─── 门禁证据 ─────────────────────────────────────────────────────────

export type UnavailableReason = "toolchain" | "postgres" | "openssl" | "network";

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
  /** 计划 §2.4 的门编号（G0–G10）与名称。 */
  readonly gate: string;
  readonly requirement: string;
  readonly status: "satisfied" | "partial" | "not-executed";
  readonly evidence: string;
}

export interface N29AcceptanceEnvelope {
  schema: string;
  generatedAt: string;
  plan: string;
  evaluatedCommit: string;
  implementationTreeClean: boolean;
  trustPolicy: {
    policyId: string;
    version: string;
    digest: string;
    keyId: string;
    humanPrincipalId: string;
    issuer: string;
  };
  /** provisional evaluator（台账绑定 + 正向分母 + 组合层负向计数）。 */
  evaluator: N29EvaluatorResult;
  positiveDenominators: readonly DenominatorRow[];
  ledgerNegatives: readonly DenominatorRow[];
  negativeSentinels: Readonly<Record<string, SentinelEvidence>>;
  focused: CommandGateEvidence;
  n29Typecheck: CommandGateEvidence;
  rootTypecheck: CommandGateEvidence;
  n28Typecheck: CommandGateEvidence;
  lint: CommandGateEvidence;
  build: CommandGateEvidence;
  fullRegression: CommandGateEvidence;
  realismGates: readonly RealismGateEvidence[];
  decision: "MIN_INNER_LOOP_GO" | "NO-GO" | "EVALUATION-INCOMPLETE";
  reasons: readonly string[];
  disclaimer: string;
}

const GATE_ORDER = [
  "focused",
  "n29Typecheck",
  "rootTypecheck",
  "n28Typecheck",
  "lint",
  "build",
  "fullRegression",
] as const;

type GateName = (typeof GATE_ORDER)[number];

function gatesOf(envelope: N29AcceptanceEnvelope): Array<[GateName, CommandGateEvidence]> {
  return GATE_ORDER.map((name) => [name, envelope[name]] as [GateName, CommandGateEvidence]);
}

// ─── 纯判定（可单测；不执行任何命令） ───────────────────────────────────

export interface DecisionOutcome {
  readonly decision: N29AcceptanceEnvelope["decision"];
  readonly reasons: readonly string[];
}

export function decideN29Acceptance(
  envelope: N29AcceptanceEnvelope,
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
  if (envelope.fullRegression.started && envelope.fullRegression.exitCode === 0) {
    const expected = JSON.stringify(N29_ACCEPTED_FULL_SKIPS.map((s) => ({ ...s })));
    const actual = JSON.stringify(envelope.fullRegression.skipped.map((s) => ({ ...s })));
    if (actual !== expected) noGo.push(`fullRegression skip manifest changed: ${actual}`);
  }

  // 分母 / sentinel 只有在 focused 真的跑过时才作为 NO-GO 判据；
  // focused 未启动属于"证据不足"，由上面的 incomplete 覆盖。
  if (envelope.focused.started) {
    if (envelope.evaluator.decision !== "PASS") {
      for (const reason of envelope.evaluator.reasons) noGo.push(`evaluator: ${reason}`);
      if (envelope.evaluator.reasons.length === 0) noGo.push("evaluator: FAIL without reason");
    }
    for (const row of envelope.positiveDenominators) {
      if (!row.ok) noGo.push(`positive denominator ${row.name}: actual=${String(row.actual)} required>=${row.required}`);
    }
    for (const [sentinel, evidence] of Object.entries(envelope.negativeSentinels)) {
      // P1-3 修复：exact denominator——冻结 matcher 必须逐条覆盖（至少一条 passed），
      // 未覆盖（missing 含"命中但全 failed"）或存在 failing 用例即 NO-GO。
      if (evidence.missing.length > 0) noGo.push(`negative sentinel ${sentinel}: ${evidence.missing.length} matcher 未覆盖（missing=${JSON.stringify(evidence.missing)}）`);
      if (evidence.failed > 0) noGo.push(`negative sentinel ${sentinel}: ${evidence.failed} failing test`);
      if (evidence.passed === 0) noGo.push(`negative sentinel ${sentinel}: 0 passing test`);
    }
  }

  for (const gate of envelope.realismGates) {
    if (gate.status !== "satisfied") incomplete.push(`realism ${gate.gate} (${gate.status}): ${gate.evidence}`);
  }

  if (noGo.length > 0) return { decision: "NO-GO", reasons: [...noGo, ...incomplete] };
  if (incomplete.length > 0) return { decision: "EVALUATION-INCOMPLETE", reasons: incomplete };
  return { decision: "MIN_INNER_LOOP_GO", reasons: [] };
}

/**
 * 真实性门禁（计划 §2.4 G3/G6/G8/G9/G10）处置：
 * 能从本次 focused 报告里取证的就据实取证，取不到的必须显式记 `not-executed`，
 * 不允许用"已有等价 mock 覆盖"充当满足。
 */
/**
 * G9-c release canary 证据：`docs/pth/n29-canary-evidence.json` 由
 * `scripts/n29-canary-gpe-wikipedia.ts` 在真实公网来源上产出并绑定当时的 evaluatedCommit。
 * 证据 commit 必须是当前 HEAD 的祖先或等于当前 HEAD（后续只允许 docs/证据提交），
 * 且 official entry + admitted revision + artifact hash + ≥1 evidence 完整。
 */
export function resolveCanaryRealismGate(
  repoRoot: string,
  currentHead: string,
  evidence: unknown,
): { status: "satisfied"; evidence: string } | { status: "not-executed"; evidence: string } {
  const e = evidence as {
    kind?: string;
    evaluatedCommit?: string;
    admittedRevisionId?: string;
    artifactHash?: string;
    official?: { entryId?: string; artifactHash?: string; evidenceCount?: number };
  } | null;
  const committed = typeof e?.evaluatedCommit === "string" && e.evaluatedCommit.length === 40;
  const isAncestor = committed
    && spawnSync("git", ["merge-base", "--is-ancestor", e!.evaluatedCommit!, currentHead], { cwd: repoRoot }).status === 0;
  const contentOk =
    e?.kind === "n29-release-canary" &&
    typeof e.admittedRevisionId === "string" && e.admittedRevisionId !== "" &&
    typeof e.artifactHash === "string" && /^[0-9a-f]{64}$/.test(e.artifactHash) &&
    typeof e.official?.entryId === "string" && e.official.entryId !== "" &&
    (e.official?.evidenceCount ?? 0) >= 1;
  if (committed && isAncestor && contentOk) {
    return {
      status: "satisfied",
      evidence: `n29-canary-evidence.json：真实 HTTPS 来源（gpe.wikipedia.org/wiki/Wikipedia）完整生产组合完成——initial fetch → official，evidenceCount=${e!.official!.evidenceCount}，admittedRevision=${e!.admittedRevisionId}，artifactHash=${e!.artifactHash}，绑定 commit=${e!.evaluatedCommit}（当前 HEAD 的祖先/相等）`,
    };
  }
  return {
    status: "not-executed",
    evidence: `n29-canary-evidence.json 缺失/不完整/绑定 commit 不是当前 HEAD 的祖先（kind=${String(e?.kind ?? "missing")}, committed=${String(committed)}, isAncestor=${String(isAncestor)}, contentOk=${String(contentOk)}）；需 PTL Human Interface 真实签发与获批出网通道`,
  };
}

export function deriveRealismGates(assertions: readonly VitestAssertion[]): RealismGateEvidence[] {
  const passedTitle = (file: string, pattern: RegExp): boolean =>
    assertions.some((a) => a.file === file && pattern.test(a.fullName) && a.status === "passed");

  const tlsTransport = passedTitle(
    "test/pth-knowledge-intake/fetch-broker.test.ts",
    /defaultWebRequest 走真实 TLS/,
  );
  const tlsFullLoop = passedTitle(
    "test/pth-knowledge-intake/minimal-loop-tls.integration.test.ts",
    /initial crawl 经真实 TLS/,
  );
  const dualScannerInProcess = passedTitle(
    "test/pth-knowledge-intake/knowledge-intake-pg.test.ts",
    /双 scanner 并发/,
  );
  const dualDrainerInProcess = passedTitle(
    "test/pth-tasking/side-effect-outbox.test.ts",
    /two concurrent drainers never claim the same row/,
  );
  const dualOsDrainer = passedTitle(
    "test/pth-knowledge-intake/g8-dual-process.test.ts",
    /dual OS-process drainers/,
  );
  const sigkillRecovery = passedTitle(
    "test/pth-knowledge-intake/g8-dual-process.test.ts",
    /SIGKILL 恢复/,
  );
  const sigkillBeforeArtifact = passedTitle(
    "test/pth-knowledge-intake/g8-stage-sigkill.test.ts",
    /SIGKILL 恢复：artifact 写入前/,
  );
  const sigkillAfterAggregateOutbox = passedTitle(
    "test/pth-knowledge-intake/g8-stage-sigkill.test.ts",
    /SIGKILL 恢复：aggregate\+outbox commit 后/,
  );
  const sigkillAfterHandlerResult = passedTitle(
    "test/pth-knowledge-intake/g8-stage-sigkill.test.ts",
    /SIGKILL 恢复：handler 写结果后/,
  );
  const stageSigkillPoints = sigkillBeforeArtifact && sigkillAfterAggregateOutbox && sigkillAfterHandlerResult;
  const leaseRecovery = passedTitle(
    "test/pth-knowledge-intake/knowledge-intake-pg.test.ts",
    /lease 过期可由新 claim 回收/,
  );
  const sabotageTrust = passedTitle(
    "test/pth-knowledge-intake/g10-sabotage-sensitivity.test.ts",
    /trust-policy-attestation-bypass/,
  );
  const sabotageEvidence = passedTitle(
    "test/pth-knowledge-intake/g10-sabotage-sensitivity.test.ts",
    /evidence-gate-skip/,
  );
  const sabotageDigest = passedTitle(
    "test/pth-knowledge-intake/g10-sabotage-sensitivity.test.ts",
    /digest-binding-skip/,
  );
  const sabotageLease = passedTitle(
    "test/pth-knowledge-intake/g10-sabotage-sensitivity.test.ts",
    /lease-gate-skip/,
  );
  const sabotageStale = passedTitle(
    "test/pth-knowledge-intake/g10-sabotage-sensitivity.test.ts",
    /stale-gate-skip/,
  );
  const g10FiveGates = sabotageTrust && sabotageEvidence && sabotageDigest && sabotageLease && sabotageStale;

  return [
    {
      gate: "G9-a 受控 TLS 来源（生产 transport）",
      requirement: "生产 transport（defaultWebRequest）经真实 TLS socket 完成抓取/重定向/条件请求",
      status: tlsTransport ? "satisfied" : "not-executed",
      evidence: tlsTransport
        ? "test/pth-knowledge-intake/fetch-broker.test.ts::defaultWebRequest 走真实 TLS：redirect/hash/条件请求全链路 = passed"
        : "未在本次 focused 报告中观察到 TLS 用例通过（openssl 缺失会使该用例被 runIf 跳过）",
    },
    {
      gate: "G9-b 受控 TLS 来源跑完整生产组合",
      requirement: "minimal-loop 全链路（scanner→fetch→admit→extract→verify→promote→Broker）跑在受控 TLS server 上",
      status: tlsFullLoop ? "satisfied" : "not-executed",
      evidence: tlsFullLoop
        ? "minimal-loop-tls.integration.test.ts::initial crawl 经真实 TLS → official；unchanged 304 重爬；changed 重爬 stale+supersede = passed（真实 TLS socket + 生产 transport + 全内环组件；仅 LlmFn 后端替换）"
        : "TLS 全链路组合未在本次 focused 报告中观察到（openssl 缺失会使该套件被 runIf 跳过）",
    },
    {
      gate: "G9-c release canary（真实 HTTPS 来源）",
      requirement: "对一个人类策略已批准的真实公网 HTTPS 来源完成 initial fetch → official 并回放 evidence",
      status: "not-executed",
      evidence: "本轮用户裁决不做真实公网 canary（需 PTL Human Interface 的真实签发流程与获批出网通道）；按计划 §5 Task 7 Step 4 记 EVALUATION-INCOMPLETE，未放宽 matcher 或改用 direct-store 让它通过",
    },
    {
      gate: "G8-a 双 OS 进程 drainer",
      requirement: "两个独立操作系统进程同时 drain 同一 PG outbox，无重复晋升",
      status: dualOsDrainer ? "satisfied" : "not-executed",
      evidence: dualOsDrainer
        ? "g8-dual-process.test.ts::dual OS-process drainers = passed（两个独立 tsx 子进程并发消费同一 outbox，(tenant,key) 唯一约束 + 处理计数证明恰好一次）"
        : `未观察到双 OS 进程用例；同进程证据：dualDrainer=${String(dualDrainerInProcess)}, dualScanner=${String(dualScannerInProcess)}`,
    },
    {
      gate: "G8-b SIGKILL 重启恢复",
      requirement: "在 artifact 写入前 / aggregate+outbox commit 后 / handler 写结果后三个故障点 SIGKILL 真实子进程并由新进程读 PG 恢复",
      status: stageSigkillPoints ? "satisfied" : sigkillRecovery ? "partial" : "not-executed",
      evidence: stageSigkillPoints
        ? "g8-stage-sigkill.test.ts：artifact 写入前（storeAcquisition 端口包装挂起→kill -9→零 artifact 中间态→新进程重跑 fetch 完成）、aggregate+outbox commit 后（transitionRun 真实提交后挂起→run=admit+extract outbox pending→新进程接管）、handler 写结果后（ingest 真实落 candidate/plan 后挂起→extract 重放幂等）三个故障点全部 passed；每例断言唯一 run/official/plan、2 verdict、outbox 全 done 且被杀行 attempts≥2。另有 g8-dual-process.test.ts 的 outbox 级 SIGKILL 用例（attempts=2、结果行唯一）"
        : `未观察到三个阶段级 SIGKILL 用例（beforeArtifact=${String(sigkillBeforeArtifact)}, afterAggregateOutbox=${String(sigkillAfterAggregateOutbox)}, afterHandlerResult=${String(sigkillAfterHandlerResult)}）；outbox 级 SIGKILL=${String(sigkillRecovery)}，进程内 lease 回收证据 leaseRecovery=${String(leaseRecovery)}`,
    },
    {
      gate: "G10 敏感度（sabotage）",
      requirement: "移除 trust/evidence/digest/lease/stale 任一门禁后至少一个 sentinel 必须翻红",
      status: g10FiveGates ? "satisfied" : "not-executed",
      evidence: g10FiveGates
        ? "g10-sabotage-sensitivity.test.ts 五项全部 passed：trust-policy-attestation-bypass（伪造 policy 在无 verifier 注入时可安装/有 verifier 被拒 → fakePolicyInstall）、evidence-gate-skip（注入恒接受 evidenceQuoteVerifier 后篡改 quoteHash 通过/缺省服务端复算拒绝 → evidenceQuoteRecheck）、digest-binding-skip（naive evaluator 恒 ok 可晋升空绑定 candidate/缺 evaluator 被拒 → legacyEmptyBindingPromotion）、lease-gate-skip（注入恒 true leaseGuard 后过期 lease 仍可阶段提交+写 outbox/缺省严格门禁零行 → expiredLease）、stale-gate-skip（恒 allow 策略时 unchanged 成功/deny 时 verdict=deny → unchangedUsePolicyDeny）"
        : `sabotage 敏感度未全部通过：trust=${String(sabotageTrust)} evidence=${String(sabotageEvidence)} digest=${String(sabotageDigest)} lease=${String(sabotageLease)} stale=${String(sabotageStale)}`,
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
    kind: "postgres",
    ok: docker.status === 0,
    detail: `docker(Testcontainers PostgreSQL) → ${(docker.stdout ?? docker.stderr ?? "").trim().slice(0, 160)}`,
  });
  const openssl = spawnSync("openssl", ["version"], { encoding: "utf8", timeout: 10_000 });
  probes.push({
    kind: "openssl",
    ok: openssl.status === 0,
    detail: `受控 TLS 自签证书 → ${(openssl.stdout ?? openssl.stderr ?? "").trim().slice(0, 120)}`,
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

async function readCanaryEvidence(repoRoot: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(repoRoot, "docs/pth/n29-canary-evidence.json"), "utf8"));
  } catch {
    return null;
  }
}

function applyCanaryEvidence(
  gates: RealismGateEvidence[],
  evidence: unknown,
  repoRoot: string,
  currentHead: string,
): RealismGateEvidence[] {
  const resolved = resolveCanaryRealismGate(repoRoot, currentHead, evidence);
  return gates.map((gate) => (gate.gate.startsWith("G9-c") ? { gate: gate.gate, requirement: gate.requirement, ...resolved } : gate));
}

// ─── 采集 ─────────────────────────────────────────────────────────────

export async function collect(repoRoot: string, output?: string): Promise<N29AcceptanceEnvelope> {
  const currentHead = gitHead(repoRoot);
  const cleanBefore = treeClean(repoRoot);
  const probes = preflight();
  const unavailable = (kind: UnavailableReason): UnavailableReason | undefined =>
    probes.find((p) => p.kind === kind)?.ok ? undefined : kind;

  const dir = await mkdtemp(path.join(tmpdir(), "n29-accept-"));
  const focusedJson = path.join(dir, "focused.json");
  const fullJson = path.join(dir, "full.json");
  const ledgerPath = path.join(dir, "ledger.json");

  // 执行顺序：`npx tsc --noEmit`（root project）按仓库既有约定依赖 workspace 包的
  // `dist/*.d.ts`（tsconfig.json 的 paths 指向 dist），因此必须排在 `npm run build`/
  // `npm run lint` 之后；N28/N29 两个 project 的 paths 指向 source，不受该顺序影响。
  const build = runGate("npm run build", {
    cwd: repoRoot,
    unavailableReason: unavailable("toolchain"),
    timeoutMs: 1_800_000,
  });
  const lint = runGate("npm run lint", {
    cwd: repoRoot,
    unavailableReason: unavailable("toolchain"),
    timeoutMs: 900_000,
  });
  const n29Typecheck = runGate("npx tsc -p tsconfig.n29.json --noEmit", {
    cwd: repoRoot,
    unavailableReason: unavailable("toolchain"),
    timeoutMs: 900_000,
  });
  const rootTypecheck = runGate("npx tsc --noEmit", {
    cwd: repoRoot,
    unavailableReason: unavailable("toolchain"),
    timeoutMs: 900_000,
  });
  const n28Typecheck = runGate("npx tsc -p tsconfig.n28.json --noEmit", {
    cwd: repoRoot,
    unavailableReason: unavailable("toolchain"),
    timeoutMs: 900_000,
  });
  const focusedCommand = `npx vitest run ${N29_FOCUSED_TEST_FILES.join(" ")} --reporter=json --outputFile ${focusedJson} --hookTimeout 60000`;
  const focused = runGate(focusedCommand, {
    cwd: repoRoot,
    env: { N29_INTAKE_LEDGER: ledgerPath, N29_ACCEPT_COMMIT: currentHead },
    unavailableReason: unavailable("toolchain") ?? unavailable("postgres"),
    timeoutMs: 3_600_000,
  });
  const fullRegression = runGate(`npm test -- --reporter=json --outputFile ${fullJson} --hookTimeout 60000`, {
    cwd: repoRoot,
    unavailableReason: unavailable("toolchain") ?? unavailable("postgres"),
    timeoutMs: 5_400_000,
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
  if (fullRegression.started) {
    try {
      const fullAssertions = collectVitestAssertions(JSON.parse(await readFile(fullJson, "utf8")), repoRoot);
      fullRegression.skipped = buildSkipManifest(fullAssertions);
      fullRegression.totals = summarizeVitest(fullAssertions);
    } catch (error) {
      fullRegression.stderrTail = `${fullRegression.stderrTail ?? ""}\n[driver] full JSON 报告不可解析：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  let ledgerRaw: unknown = null;
  try {
    ledgerRaw = JSON.parse(await readFile(ledgerPath, "utf8"));
  } catch { /* 台账缺失 → evaluator 给出结构化 FAIL 原因 */ }

  const evaluator = evaluateN29Ledger({ ledger: ledgerRaw, expectedCommit: currentHead });
  const ledgerPositives = (ledgerRaw as { positives?: Record<string, number> } | null)?.positives;
  const ledgerNegativeCounts = (ledgerRaw as { negatives?: Record<string, number> } | null)?.negatives;
  const policy = (ledgerRaw as { policy?: Record<string, string> } | null)?.policy;

  const envelope: N29AcceptanceEnvelope = {
    schema: N29_ENVELOPE_SCHEMA,
    generatedAt: new Date().toISOString(),
    plan: "docs/pth/n29-minimal-knowledge-intake-loop-feedback-plan.md",
    evaluatedCommit: currentHead,
    implementationTreeClean: cleanBefore && treeClean(repoRoot),
    trustPolicy: {
      policyId: policy?.["policyId"] ?? "",
      version: policy?.["version"] ?? "",
      digest: policy?.["digest"] ?? "",
      keyId: policy?.["keyId"] ?? "",
      humanPrincipalId: policy?.["humanPrincipalId"] ?? "",
      issuer: policy?.["issuer"] ?? "",
    },
    evaluator,
    positiveDenominators: checkDenominators(ledgerPositives, N29_REQUIRED_POSITIVES),
    ledgerNegatives: checkDenominators(ledgerNegativeCounts, N29_REQUIRED_LEDGER_NEGATIVES),
    negativeSentinels: deriveNegativeSentinels(focusedAssertions),
    focused,
    n29Typecheck,
    rootTypecheck,
    n28Typecheck,
    lint,
    build,
    fullRegression,
    realismGates: applyCanaryEvidence(
      deriveRealismGates(focusedAssertions),
      await readCanaryEvidence(repoRoot),
      repoRoot,
      currentHead,
    ),
    decision: "EVALUATION-INCOMPLETE",
    reasons: [],
    disclaimer: N29_DISCLAIMER,
  };

  const outcome = decideN29Acceptance(envelope, { currentHead });
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
    `[accept-n29] decision=${envelope.decision} commit=${envelope.evaluatedCommit} reasons=${envelope.reasons.length}\n`,
  );
  process.exitCode = envelope.decision === "MIN_INNER_LOOP_GO" ? 0 : envelope.decision === "NO-GO" ? 1 : 2;
}
