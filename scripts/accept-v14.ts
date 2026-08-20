/**
 * scripts/accept-v14.ts —— v1.4 Operator Console UX 权威验收驱动。
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGate, preflight, type UnavailableReason } from "./accept-n30-runtime-observatory.js";
import {
  buildSkipManifest,
  collectVitestAssertions,
  summarizeVitest,
  type VitestAssertion,
} from "./eval-n30-runtime-observatory.js";

const V14_ENVELOPE_SCHEMA = "v14-operator-console-ux-acceptance/1";
const V14_ACCEPTED_FULL_SKIPS = [{ file: "test/pth-execution/sandbox-security.integration.test.ts", tests: 9 }];
const V14_FOCUSED_FILES = [
  "test/unit/operator-console-*.test.ts",
  "test/pth-composition/operator-console-*.test.ts",
  "test/browser/runtime-observatory.test.ts",
];

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

  const prepBuildWeb = runGate("npx tsc -p packages/pth-console && npm run build:web -w @away_from/pth-console", {
    cwd: repoRoot, unavailableReason: unavailable("toolchain"), timeoutMs: 900_000,
  });
  if (prepBuildWeb.started && prepBuildWeb.exitCode !== 0) reasons.push("build:web non-zero");
  if (!prepBuildWeb.started) reasons.push("build:web unavailable: EVALUATION-INCOMPLETE");

  const evalRuns: { status: number | null; stdout: string; stderr: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const r = spawnSync("node", ["--import", "tsx", "scripts/eval-v14-operator-console-ux.ts"], {
      cwd: repoRoot, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
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

  const typecheck = runGate("npm run typecheck:web -w @away_from/pth-console", {
    cwd: repoRoot, unavailableReason: unavailable("toolchain"), timeoutMs: 300_000,
  });
  gates.typecheckWeb = { exitCode: typecheck.exitCode, note: typecheck.stdoutTail?.slice(-200) ?? "" };
  if (typecheck.started && typecheck.exitCode !== 0) reasons.push("typecheck:web non-zero");
  if (!typecheck.started) reasons.push("typecheck:web unavailable: EVALUATION-INCOMPLETE");

  const playwright = runGate("npm run test:e2e -w @away_from/pth-console", {
    cwd: repoRoot, unavailableReason: unavailable("toolchain"), timeoutMs: 900_000,
  });
  gates.playwright = { exitCode: playwright.exitCode, note: playwright.stdoutTail?.slice(-500) ?? "" };
  if (playwright.started && playwright.exitCode !== 0) reasons.push("playwright non-zero");
  if (!playwright.started) reasons.push("playwright unavailable: EVALUATION-INCOMPLETE");

  const dir = await mkdtemp(path.join(tmpdir(), "v14-accept-"));
  const focusedJson = path.join(dir, "focused.json");
  const fullJson = path.join(dir, "full.json");

  const focused = runGate(
    `npx vitest run ${V14_FOCUSED_FILES.join(" ")} --reporter=json --outputFile ${focusedJson} --hookTimeout 60000 --testTimeout 120000 --maxWorkers=2`,
    { cwd: repoRoot, unavailableReason: unavailable("toolchain") ?? unavailable("docker"), timeoutMs: 3_600_000 },
  );
  if (focused.started) {
    try {
      const assertions: VitestAssertion[] = collectVitestAssertions(JSON.parse(await readFile(focusedJson, "utf8")), repoRoot);
      const totals = summarizeVitest(assertions);
      const skips = buildSkipManifest(assertions);
      gates.focused = gateWithTotals(focused.exitCode, totals.skipped, totals.failed, `files=${totals.files} tests=${totals.tests} passed=${totals.passed}`);
      if (skips.length > 0) reasons.push(`focused skip manifest not empty: ${JSON.stringify(skips)}`);
    } catch (error) {
      gates.focused = gateWithTotals(focused.exitCode, 0, 0, `json unparseable: ${error instanceof Error ? error.message : String(error)}`);
      reasons.push("focused JSON report unparseable");
    }
  } else {
    gates.focused = { exitCode: focused.exitCode, note: `unavailable: ${focused.unavailableReason ?? "unknown"}` };
    reasons.push("focused unavailable: EVALUATION-INCOMPLETE");
  }
  if (focused.started && focused.exitCode !== 0) reasons.push(`focused: exit=${String(focused.exitCode)}`);

  runGate("docker restart v13-asm-toolchain && sleep 2", { cwd: repoRoot, timeoutMs: 120_000 });
  const full = runGate(`npm test -- --reporter=json --outputFile ${fullJson} --hookTimeout 60000 --maxWorkers=4`, {
    cwd: repoRoot, unavailableReason: unavailable("toolchain") ?? unavailable("docker"), timeoutMs: 5_400_000,
  });
  if (full.started) {
    try {
      const assertions: VitestAssertion[] = collectVitestAssertions(JSON.parse(await readFile(fullJson, "utf8")), repoRoot);
      const totals = summarizeVitest(assertions);
      const skips = buildSkipManifest(assertions);
      const expected = JSON.stringify(V14_ACCEPTED_FULL_SKIPS);
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
  if (full.started && full.exitCode !== 0) {
    reasons.push(`full: exit=${String(full.exitCode)}`);
    try { await writeFile("/tmp/v14-full-failed.json", await readFile(fullJson)); } catch { /* diagnostic only */ }
  }

  for (const gate of ["lint", "build"] as const) {
    const g = runGate(`npm run ${gate}`, { cwd: repoRoot, unavailableReason: unavailable("toolchain"), timeoutMs: gate === "build" ? 1_800_000 : 900_000 });
    gates[gate] = { exitCode: g.exitCode, note: g.stdoutTail?.slice(-300) ?? "" };
    if (!g.started) reasons.push(`${gate} unavailable: EVALUATION-INCOMPLETE`);
    else if (g.exitCode !== 0) reasons.push(`${gate} non-zero`);
  }

  const envelopeChecks: Array<{ name: string; rel: string; accepted: readonly string[] }> = [
    { name: "n29Envelope", rel: "docs/pth/n29-minimal-intake-acceptance.json", accepted: ["MIN_INNER_LOOP_GO", "GO"] },
    { name: "n30Envelope", rel: "docs/pth/n30-runtime-observatory-envelope.json", accepted: ["GO"] },
    { name: "n33Envelope", rel: "docs/pth/n33-operator-console-envelope.json", accepted: ["GO"] },
  ];
  for (const check of envelopeChecks) {
    try {
      const decision = (JSON.parse(await readFile(path.join(repoRoot, check.rel), "utf8")) as { decision?: string }).decision;
      if (decision && check.accepted.includes(decision)) gates[check.name] = { exitCode: 0, note: decision };
      else {
        gates[check.name] = { exitCode: 1, note: `decision=${decision ?? "missing"}` };
        reasons.push(`${check.name} not accepted: EVALUATION-INCOMPLETE`);
      }
    } catch {
      gates[check.name] = { exitCode: 1, note: "missing (EVALUATION-INCOMPLETE)" };
      reasons.push(`${check.name} missing: EVALUATION-INCOMPLETE`);
    }
  }

  const decision = reasons.length === 0 ? "GO"
    : reasons.every((reason) => reason.includes("EVALUATION-INCOMPLETE")) ? "EVALUATION-INCOMPLETE"
    : "NO-GO";

  const envelope = {
    schema: V14_ENVELOPE_SCHEMA,
    generatedAt: new Date().toISOString(),
    plan: "docs/superpowers/plans/2026-08-21-v14-operator-console-ux.md",
    evaluatedCommit: head,
    implementationTreeClean: clean,
    decision,
    gates,
    reasons,
    skipManifest: { allowed: V14_ACCEPTED_FULL_SKIPS, observed: gates.full?.skipped ?? null },
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
