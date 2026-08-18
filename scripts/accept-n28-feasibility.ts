/**
 * scripts/accept-n28-feasibility.ts —— N28 最终验收驱动（唯一 GO/NO-GO 权威）。
 *
 * evaluator 判定只是 provisional；本驱动收集 evaluatedCommit/工作树/四道门禁/两次
 * evaluator 证据并调用 decideN28Acceptance。进程退出：0=GO / 1=NO-GO / 2=EVALUATION-INCOMPLETE。
 */

import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { evaluateN28Feasibility, type N28FeasibilityResult } from "./eval-n28-feasibility.js";
import { N28_ACCEPTED_BASELINE_SKIPS } from "./n28-feasibility-fixture.js";

export interface CommandGateEvidence {
  command: string;
  started: boolean;
  exitCode: number | null;
  skipped: readonly { file: string; tests: number }[];
  environmentStatus: "available" | "unavailable";
  unavailableReason?: "postgres" | "redis" | "sandbox" | "toolchain";
  /** P1-4 修复：门禁输出可追溯（失败证据保留）。 */
  stdout?: string;
  stderr?: string;
}

export interface N28AcceptanceEnvelope {
  evaluatedCommit: string;
  implementationTreeClean: boolean;
  evaluator: { first: N28FeasibilityResult; second: N28FeasibilityResult; byteIdentical: boolean };
  focused: CommandGateEvidence;
  n28Typecheck: CommandGateEvidence;
  fullRegression: CommandGateEvidence;
  lint: CommandGateEvidence;
  decision: "GO" | "NO-GO" | "EVALUATION-INCOMPLETE";
  reasons: readonly string[];
}

export const N28_FOCUSED_TEST_FILES = [
  "test/pth-contracts/cognitive-responsibility.test.ts",
  "test/pth-kernel-execution/worker-cluster.test.ts",
  "test/pth-kernel-execution/role-lineage.test.ts",
  "test/pth-config/config.test.ts",
  "test/pth-kernel-execution/worker-replica.test.ts",
  "test/pth-kernel-execution/worker-slot-assembly.test.ts",
  "test/pth-kernel-execution/worker-slot-runtime.test.ts",
  "test/pth-kernel-execution/batch-runtime-assembly.test.ts",
  "test/pth-kernel-execution/task-loop.test.ts",
  "test/pth-kernel-execution/batch-manager.test.ts",
  "test/pth-execution/memory-type-classifier.test.ts",
  "test/pth-execution/memory-directory.test.ts",
  "test/pth-execution/knowledge-ranking.test.ts",
  "test/pth-execution/verified-task-read-scope.test.ts",
  "test/pth-execution/layered-knowledge-retriever.test.ts",
  "test/pth-kernel-execution/cognitive-budget.test.ts",
  "test/pth-runner/authorized-state-reads.test.ts",
  "test/pth-runner/authorized-task-reads.test.ts",
  "test/pth-runner/cognitive-working-set.test.ts",
  "test/pth-tasking/task-outcome-observers.test.ts",
  "test/pth-execution/knowledge-broker.test.ts",
  "test/pth-runner/knowledge-context.test.ts",
  "test/pth-runner/agent-task-runner.test.ts",
  "test/pth-kernel-execution/agent-loop.test.ts",
  "test/pth-kernel-execution/prompt-docs.test.ts",
  "test/pth-kernel-execution/agent-tool-convergence.test.ts",
  "test/pth-kernel-execution/agent-loop-working-set.integration.test.ts",
  "test/pth-kernel-execution/agent-loop-ptc.integration.test.ts",
  "test/pth-runner/cognitive-responsibility.vertical.test.ts",
  "test/pth-runner/n28-feasibility-evaluator.test.ts",
  "test/pth-runner/n28-feasibility-acceptance.test.ts",
] as const;

export function parseVitestSkipManifest(json: unknown, repoRoot: string): { file: string; tests: number }[] {
  if (typeof json !== "object" || json === null || !Array.isArray((json as { testResults?: unknown }).testResults)) {
    throw new Error("unknown vitest json shape（缺 testResults 数组）");
  }
  const byFile = new Map<string, number>();
  for (const result of (json as { testResults: Array<{ name?: unknown; assertionResults?: unknown }> }).testResults) {
    if (typeof result.name !== "string" || !Array.isArray(result.assertionResults)) throw new Error("unknown vitest testResult row shape");
    const rel = path.relative(repoRoot, result.name).split(path.sep).join("/");
    let count = 0;
    for (const assertion of result.assertionResults as Array<{ status?: unknown }>) {
      if (assertion.status === "pending" || assertion.status === "skipped" || assertion.status === "todo" || assertion.status === "disabled") count += 1;
    }
    byFile.set(rel, (byFile.get(rel) ?? 0) + count);
  }
  return [...byFile.entries()].filter(([, count]) => count > 0).map(([file, tests]) => ({ file, tests })).sort((a, b) => a.file.localeCompare(b.file));
}

function preflight(): Array<{ kind: CommandGateEvidence["unavailableReason"]; ok: boolean; detail: string }> {
  const probes: Array<{ kind: CommandGateEvidence["unavailableReason"]; ok: boolean; detail: string }> = [];
  const node = spawnSync("node", ["--version"], { encoding: "utf8" });
  const npm = spawnSync("npm", ["--version"], { encoding: "utf8" });
  probes.push({ kind: "toolchain", ok: node.status === 0 && npm.status === 0, detail: `node=${(node.stdout ?? "").trim()} npm=${(npm.stdout ?? "").trim()}` });
  const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 15_000 });
  probes.push({ kind: "postgres", ok: docker.status === 0, detail: (docker.stdout ?? docker.stderr ?? "").trim().slice(0, 200) });
  // P1-4 修复：Redis preflight 使用项目配置 endpoint，而不是固定 redis-cli ping。
  const redisUrl = process.env["PTH_REDIS_URL"] ?? process.env["REDIS_URL"] ?? "redis://localhost:6379";
  let redisArgs = ["ping"];
  try {
    const parsed = new URL(redisUrl);
    if (parsed.hostname) redisArgs = ["-h", parsed.hostname, "-p", parsed.port || "6379", "ping"];
  } catch { /* 非法 URL：使用默认 */ }
  const redis = spawnSync("redis-cli", redisArgs, { encoding: "utf8", timeout: 5_000 });
  probes.push({ kind: "redis", ok: redis.status === 0, detail: `${redisUrl} → ${(redis.stdout ?? redis.stderr ?? "").trim().slice(0, 100)}` });
  probes.push({ kind: "sandbox", ok: true, detail: "基线沙箱集成套件 9 例 skip 为既有清单（本实验不要求沙箱环境）" });
  return probes;
}

function gate(command: string, unavailableReason?: CommandGateEvidence["unavailableReason"]): CommandGateEvidence {
  if (unavailableReason) {
    return { command, started: false, exitCode: null, skipped: [], environmentStatus: "unavailable", unavailableReason };
  }
  const started = true;
  const run = spawnSync(command, { shell: true, encoding: "utf8", timeout: 900_000, env: { ...process.env, TSX_TSCONFIG_PATH: "tsconfig.n28.json" } });
  return {
    command,
    started,
    exitCode: run.status,
    skipped: [],
    environmentStatus: "available",
    stdout: (run.stdout ?? "").slice(-20_000),
    stderr: (run.stderr ?? "").slice(-20_000),
  };
}

export function decideN28Acceptance(envelope: N28AcceptanceEnvelope, opts: { currentHead: string }): N28AcceptanceEnvelope["decision"] {
  const reasons: string[] = [];
  if (!envelope.evaluatedCommit || envelope.evaluatedCommit !== opts.currentHead) reasons.push(`evaluatedCommit=${envelope.evaluatedCommit} != HEAD=${opts.currentHead}`);
  if (!envelope.implementationTreeClean) reasons.push("implementation tree not clean");
  if (!envelope.evaluator.byteIdentical || envelope.evaluator.first.decision !== "GO" || envelope.evaluator.second.decision !== "GO") reasons.push("evaluator not byte-identical provisional GO");
  for (const [name, g] of Object.entries({ focused: envelope.focused, n28Typecheck: envelope.n28Typecheck, fullRegression: envelope.fullRegression, lint: envelope.lint }) as Array<[string, CommandGateEvidence]>) {
    if (g.environmentStatus === "unavailable") reasons.push(`${name}: environment unavailable`);
    else if (!g.started) reasons.push(`${name}: not started`);
    else if (g.exitCode !== 0) reasons.push(`${name}: exit=${g.exitCode}`);
    if (name === "focused" && g.skipped.length > 0) reasons.push(`focused: unexpected skips ${JSON.stringify(g.skipped)}`);
  }
  const baseline = JSON.stringify(N28_ACCEPTED_BASELINE_SKIPS.map((s) => ({ ...s })));
  const actual = JSON.stringify(envelope.fullRegression.skipped.map((s) => ({ ...s })));
  if (envelope.fullRegression.started && envelope.fullRegression.exitCode === 0 && actual !== baseline) reasons.push(`fullRegression skip manifest changed: ${actual}`);
  return reasons.length > 0 ? "NO-GO" : "GO";
}

async function collect(repoRoot: string, currentHead: string, output?: string): Promise<N28AcceptanceEnvelope> {
  const first = await evaluateN28Feasibility();
  const second = await evaluateN28Feasibility();
  const byteIdentical = JSON.stringify(first) === JSON.stringify(second);
  const dir = await mkdtemp(path.join(tmpdir(), "n28-accept-"));
  const focusedJson = path.join(dir, "focused.json");
  const fullJson = path.join(dir, "full.json");
  const focusedCommand = `npx vitest run ${N28_FOCUSED_TEST_FILES.join(" ")} --reporter=json --outputFile ${focusedJson}`;
  const typecheckCommand = "npx tsc -p tsconfig.n28.json --noEmit";
  const fullCommand = `npm test -- --reporter=json --outputFile ${fullJson}`;
  const lintCommand = "npm run lint";

  const preflights = preflight();
  const unavailable = (kind: CommandGateEvidence["unavailableReason"]) => preflights.find((p) => p.kind === kind)?.ok ? undefined : kind;

  const focused = gate(focusedCommand, unavailable("toolchain"));
  const n28Typecheck = gate(typecheckCommand, unavailable("toolchain"));
  const fullRegression = gate(fullCommand, unavailable("toolchain") ?? unavailable("postgres"));
  const lint = gate(lintCommand, unavailable("toolchain"));
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim() !== "";

  if (focused.started && focused.exitCode === 0) {
    // P1-4 修复：focused 零 skip 必须解析 JSON 报告确认，而不是直接赋 []。
    focused.skipped = parseVitestSkipManifest(JSON.parse(await readFile(focusedJson, "utf8")), repoRoot);
  }
  if (fullRegression.started && fullRegression.exitCode === 0) {
    fullRegression.skipped = parseVitestSkipManifest(JSON.parse(await readFile(fullJson, "utf8")), repoRoot);
  }

  const envelope: N28AcceptanceEnvelope = {
    evaluatedCommit: currentHead,
    implementationTreeClean: !dirty,
    evaluator: { first, second, byteIdentical },
    focused,
    n28Typecheck,
    fullRegression,
    lint,
    decision: "EVALUATION-INCOMPLETE",
    reasons: [],
  };
  // P1-4 再次修复：任何 started gate 非零优先判 NO-GO；只有全部 started gate 成功且
  // 存在 unavailable/not-started 的 gate 时，剩余证据不足才判 EVALUATION-INCOMPLETE。
  const gates = [focused, n28Typecheck, fullRegression, lint];
  const startedFailure = gates.some((g) => g.started && g.exitCode !== 0);
  const missingGate = gates.some((g) => g.environmentStatus === "unavailable" || !g.started);
  if (startedFailure) {
    envelope.decision = decideN28Acceptance(envelope, { currentHead });
    envelope.reasons = [
      `evaluator provisional: ${first.decision}`,
      `byteIdentical: ${byteIdentical}`,
      `focused exit=${focused.exitCode}`,
      `typecheck exit=${n28Typecheck.exitCode}`,
      `full exit=${fullRegression.exitCode} skips=${JSON.stringify(fullRegression.skipped)}`,
      `lint exit=${lint.exitCode}`,
      "direct No-Go conditions: see evaluator JSON hypotheses/direct invariants",
    ];
  } else if (missingGate) {
    envelope.decision = "EVALUATION-INCOMPLETE";
    envelope.reasons = preflights.filter((p) => !p.ok).map((p) => `${p.kind}: ${p.detail}`);
  } else {
    envelope.decision = decideN28Acceptance(envelope, { currentHead });
    envelope.reasons = envelope.decision === "GO" ? [] : [
      `evaluator provisional: ${first.decision}`,
      `byteIdentical: ${byteIdentical}`,
      `focused exit=${focused.exitCode}`,
      `typecheck exit=${n28Typecheck.exitCode}`,
      `full exit=${fullRegression.exitCode} skips=${JSON.stringify(fullRegression.skipped)}`,
      `lint exit=${lint.exitCode}`,
      "direct No-Go conditions: see evaluator JSON hypotheses/direct invariants",
    ];
  }
  await rm(dir, { recursive: true, force: true });
  const text = `${JSON.stringify(envelope, null, 2)}\n`;
  if (output) await writeFile(output, text, "utf8");
  else process.stdout.write(text);
  return envelope;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = process.argv.includes("--output") ? process.argv[process.argv.indexOf("--output") + 1] : undefined;
  const repoRoot = process.cwd();
  const currentHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  const envelope = await collect(repoRoot, currentHead, output);
  process.exitCode = envelope.decision === "GO" ? 0 : envelope.decision === "NO-GO" ? 1 : 2;
}
