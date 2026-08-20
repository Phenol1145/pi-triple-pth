/**
 * scripts/accept-v13.ts —— v1.3.0 权威验收驱动（plan Task 10 Step 4/5）。
 *
 * 绑定 evaluatedCommit：clean tree、focused/full JSON 报告、lint/build、
 * 评测器双跑字节一致、N29/N30/N33 envelope 决策、skip manifest 冻结。
 * 已启动门非零 = NO-GO；缺失 envelope = EVALUATION-INCOMPLETE；全绿才 GO。
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runGate,
  preflight,
  type UnavailableReason,
} from "./accept-n30-runtime-observatory.js";
import {
  buildSkipManifest,
  collectVitestAssertions,
  summarizeVitest,
  type VitestAssertion,
} from "./eval-n30-runtime-observatory.js";

export const V13_ENVELOPE_SCHEMA = "v13-professional-computing-acceptance/1";
const V13_ACCEPTED_FULL_SKIPS = [{ file: "test/pth-execution/sandbox-security.integration.test.ts", tests: 9 }];

interface Gate { command?: string; exitCode: number | null; note: string; skipped?: number; failed?: number }
const gates: Record<string, Gate> = {};
const reasons: string[] = [];
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function gitHead(): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
}

function treeClean(): boolean {
  return spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim() === "";
}

function passedTitle(assertions: readonly VitestAssertion[], file: string, pattern: RegExp): boolean {
  return assertions.some((a) => a.file === file && pattern.test(a.fullName) && a.status === "passed");
}

function gateWithTotals(exitCode: number | null, skipped: number, failed: number, note: string): Gate {
  return { exitCode, note: `${note} failed=${failed} skipped=${skipped}`, skipped, failed };
}

async function collect(output?: string): Promise<void> {
  const head = gitHead();
  const clean = treeClean();
  gates.cleanTree = { exitCode: clean ? 0 : 1, note: clean ? "clean" : "dirty" };
  gates.evaluatedCommit = { exitCode: 0, note: head };
  if (!clean) reasons.push("implementation tree not clean");

  const probes = preflight();
  const unavailable = (kind: UnavailableReason): UnavailableReason | undefined =>
    probes.find((p) => p.kind === kind)?.ok ? undefined : kind;

  // 评测器：同一进程外两次运行字节一致 + decision PASS
  const evalRuns: { status: number | null; stdout: string; stderr: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const r = spawnSync("node", ["--import", "tsx", "scripts/eval-v13-professional-computing.ts"], {
      cwd: repoRoot, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    evalRuns.push({ status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
  }
  if (evalRuns.some((r) => r.status !== 0)) {
    gates.evaluator = { exitCode: 1, note: `eval exit ${evalRuns.map((r) => r.status).join("/")}: ${evalRuns.find((r) => r.status !== 0)?.stderr.slice(-400)}` };
    reasons.push("evaluator crashed or non-zero");
  } else if (evalRuns[0].stdout !== evalRuns[1].stdout) {
    gates.evaluator = { exitCode: 1, note: "evaluator not byte-identical across two runs" };
    reasons.push("evaluator not byte-identical");
  } else {
    try {
      const parsed = JSON.parse(evalRuns[0].stdout) as { decision?: string; denominators?: Record<string, unknown> };
      gates.evaluator = { exitCode: parsed.decision === "PASS" ? 0 : 1, note: `decision=${parsed.decision} denominators=${JSON.stringify(parsed.denominators)}` };
      if (parsed.decision !== "PASS") reasons.push(`evaluator decision ${parsed.decision}`);
    } catch (error) {
      gates.evaluator = { exitCode: 1, note: `unparseable: ${error instanceof Error ? error.message : String(error)}` };
      reasons.push("evaluator output unparseable");
    }
  }

  const dir = await mkdtemp(path.join(tmpdir(), "v13-accept-"));
  const focusedJson = path.join(dir, "focused.json");
  const fullJson = path.join(dir, "full.json");

  const focusedFiles = [
    "test/pth-professional",
    "test/pth-composition/v13-professional-computing.test.ts",
    "test/pth-kernel-execution/professional-roles.test.ts",
  ];
  const focused = runGate(
    `npx vitest run ${focusedFiles.join(" ")} --reporter=json --outputFile ${focusedJson} --hookTimeout 60000 --testTimeout 180000`,
    { cwd: repoRoot, unavailableReason: unavailable("toolchain") ?? unavailable("docker"), timeoutMs: 3_600_000 },
  );

  let focusedAssertions: VitestAssertion[] = [];
  if (focused.started) {
    try {
      focusedAssertions = collectVitestAssertions(JSON.parse(await readFile(focusedJson, "utf8")), repoRoot);
      const totals = summarizeVitest(focusedAssertions);
      const skips = buildSkipManifest(focusedAssertions);
      gates.focused = gateWithTotals(focused.exitCode, totals.skipped, totals.failed, `files=${totals.files} tests=${totals.tests} passed=${totals.passed}`);
      if (skips.length > 0) reasons.push(`focused skip manifest not empty: ${JSON.stringify(skips)}`);
      const evidence = [
        passedTitle(focusedAssertions, "test/pth-professional/technical-educator.integration.test.ts", /(assembly|lean4|chemistry|wolfram): .*真实/),
        passedTitle(focusedAssertions, "test/pth-professional/technical-educator.integration.test.ts", /(assembly|lean4|chemistry|wolfram) 教程草稿 \+ manifest 绑定/),
        passedTitle(focusedAssertions, "test/pth-composition/v13-professional-computing.test.ts", /12 项，单点破坏只翻转自身/),
        passedTitle(focusedAssertions, "test/pth-composition/v13-professional-computing.test.ts", /同一 index entry 路由两个专业 Role/),
      ];
      if (evidence.some((ok) => !ok)) {
        reasons.push(`focused evidence missing: ${JSON.stringify(evidence)}`);
      }
    } catch (error) {
      gates.focused = gateWithTotals(focused.exitCode, 0, 0, `json unparseable: ${error instanceof Error ? error.message : String(error)}`);
      reasons.push("focused JSON report unparseable");
    }
  } else {
    gates.focused = { exitCode: focused.exitCode, note: `unavailable: ${focused.unavailableReason ?? "unknown"}` };
    reasons.push("focused unavailable: EVALUATION-INCOMPLETE");
  }

  const full = runGate(`npm test -- --reporter=json --outputFile ${fullJson} --hookTimeout 60000`, {
    cwd: repoRoot, unavailableReason: unavailable("toolchain") ?? unavailable("docker"), timeoutMs: 5_400_000,
  });
  if (full.started) {
    try {
      const fullAssertions = collectVitestAssertions(JSON.parse(await readFile(fullJson, "utf8")), repoRoot);
      const totals = summarizeVitest(fullAssertions);
      const skips = buildSkipManifest(fullAssertions);
      const expected = JSON.stringify(V13_ACCEPTED_FULL_SKIPS);
      const actual = JSON.stringify(skips);
      gates.full = gateWithTotals(full.exitCode, totals.skipped, totals.failed, `files=${totals.files} tests=${totals.tests} passed=${totals.passed}`);
      if (actual !== expected) reasons.push(`full skip manifest changed: ${actual}`);
    } catch (error) {
      gates.full = gateWithTotals(full.exitCode, 0, 0, `json unparseable: ${error instanceof Error ? error.message : String(error)}`);
      reasons.push("full JSON report unparseable");
    }
  } else {
    gates.full = { exitCode: full.exitCode, note: `unavailable: ${full.unavailableReason ?? "unknown"}` };
    reasons.push("full unavailable: EVALUATION-INCOMPLETE");
  }

  for (const gate of ["lint", "build"] as const) {
    const g = runGate(`npm run ${gate}`, { cwd: repoRoot, unavailableReason: unavailable("toolchain"), timeoutMs: gate === "build" ? 1_800_000 : 900_000 });
    gates[gate] = { exitCode: g.exitCode, note: g.stdoutTail?.slice(-300) ?? (g.unavailableReason ?? "") };
    if (!g.started) reasons.push(`${gate} unavailable: EVALUATION-INCOMPLETE`);
  }

  if (focused.started && focused.exitCode !== 0) reasons.push(`focused: exit=${String(focused.exitCode)}`);
  if (full.started && full.exitCode !== 0) {
    reasons.push(`full: exit=${String(full.exitCode)}`);
    try {
      await writeFile("/tmp/v13-full-failed.json", await readFile(fullJson));
    } catch {
      // 诊断副本失败不改变权威决策
    }
  }
  for (const gate of ["lint", "build"] as const) {
    const g = gates[gate];
    if (g.exitCode !== 0 && !reasons.some((r) => r === `${gate} unavailable: EVALUATION-INCOMPLETE`)) reasons.push(`${gate} non-zero`);
  }

  const envelopeChecks: Array<{ name: string; rel: string; accepted: readonly string[] }> = [
    { name: "n29Envelope", rel: "docs/pth/n29-minimal-intake-acceptance.json", accepted: ["MIN_INNER_LOOP_GO", "GO"] },
    { name: "n30Envelope", rel: "docs/pth/n30-runtime-observatory-envelope.json", accepted: ["GO"] },
    { name: "n33Envelope", rel: "docs/pth/n33-operator-console-envelope.json", accepted: ["GO"] },
  ];
  for (const check of envelopeChecks) {
    try {
      const decision = (JSON.parse(await readFile(path.join(repoRoot, check.rel), "utf8")) as { decision?: string }).decision;
      if (decision && check.accepted.includes(decision)) {
        gates[check.name] = { exitCode: 0, note: decision };
      } else {
        gates[check.name] = { exitCode: 1, note: `decision=${decision ?? "missing"}` };
        reasons.push(`${check.name} not accepted: EVALUATION-INCOMPLETE`);
      }
    } catch {
      gates[check.name] = { exitCode: 1, note: "missing (EVALUATION-INCOMPLETE)" };
      reasons.push(`${check.name} missing: EVALUATION-INCOMPLETE`);
    }
  }

  const decision = reasons.length === 0 ? "GO"
    : reasons.every((r) => r.includes("EVALUATION-INCOMPLETE")) ? "EVALUATION-INCOMPLETE"
    : "NO-GO";

  const envelope = {
    schema: V13_ENVELOPE_SCHEMA,
    generatedAt: new Date().toISOString(),
    plan: "docs/superpowers/plans/2026-08-19-v13-professional-computing.md",
    evaluatedCommit: head,
    implementationTreeClean: clean,
    decision,
    gates,
    reasons,
    skipManifest: { allowed: V13_ACCEPTED_FULL_SKIPS, observed: gates.full?.skipped ?? null },
  };

  await rm(dir, { recursive: true, force: true });
  const body = `${JSON.stringify(envelope, null, 2)}\n`;
  if (output) await writeFile(path.resolve(repoRoot, output), body, "utf8");
  else process.stdout.write(body);
  process.exitCode = decision === "GO" ? 0 : decision === "NO-GO" ? 1 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  await collect(output);
}
