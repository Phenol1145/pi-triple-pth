/**
 * accept-n33-operator-console.ts —— N33 权威验收驱动（v2：JSON 报告 + fail-closed）。
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
} from "../eval/eval-n30-runtime-observatory.js";

const N33_FOCUSED_FILES = [
  "test/unit/operator-console-*.test.ts",
  "test/pth-contracts/system-inspection.test.ts",
  "test/pth-application/system-inspection-facade.pg.test.ts",
  "test/pth-gateway/system-inspection-routes.test.ts",
  "test/pth-gateway/intake-routes.test.ts",
  "test/pth-composition/operator-console-*.test.ts",
];
const N33_ACCEPTED_FULL_SKIPS = [{ file: "test/pth-execution/sandbox-security.integration.test.ts", tests: 9 }];

interface Gate { command?: string; exitCode: number | null; note: string; skipped?: number; failed?: number }
const gates: Record<string, Gate> = {};
const reasons: string[] = [];

function gitHead(): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
}

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function gateJson(file: string, started: boolean, exitCode: number | null, skipped: number, failed: number, note: string): Gate {
  return { exitCode, note: `${note} failed=${failed} skipped=${skipped}`, skipped, failed };
}

async function collect(output?: string): Promise<void> {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  const clean = status === "";
  gates.cleanTree = { exitCode: clean ? 0 : 1, note: clean ? "clean" : "dirty" };
  if (!clean) reasons.push("implementation tree not clean");
  const head = gitHead();
  gates.evaluatedCommit = { exitCode: 0, note: head };

  const probes = preflight();
  const unavailable = (kind: UnavailableReason): UnavailableReason | undefined =>
    probes.find((p) => p.kind === kind)?.ok ? undefined : kind;

  // evaluator double-run byte-identical
  const evalRuns: { status: number | null; stdout: string; stderr: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const r = spawnSync("node", ["--import", "tsx", "scripts/eval/eval-n33-operator-console.ts"], {
      cwd: repoRoot, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    evalRuns.push({ status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
  }
  if (evalRuns.some((r) => r.status !== 0)) {
    gates.evaluator = { exitCode: 1, note: `eval exit ${evalRuns.map((r) => r.status).join("/")}: ${evalRuns.find((r) => r.status !== 0)?.stderr.slice(-400)}` };
    reasons.push("evaluator crashed or non-zero");
  } else if (evalRuns[0].stdout !== evalRuns[1].stdout) {
    gates.evaluator = { exitCode: 1, note: "not byte-identical across two runs" };
    reasons.push("evaluator not byte-identical");
  } else {
    try {
      const parsed = JSON.parse(evalRuns[0].stdout) as { decision?: string };
      gates.evaluator = { exitCode: parsed.decision === "PASS" ? 0 : 1, note: `decision=${parsed.decision}` };
      if (parsed.decision !== "PASS") reasons.push(`evaluator decision ${parsed.decision}`);
    } catch (error) {
      gates.evaluator = { exitCode: 1, note: `unparseable: ${error instanceof Error ? error.message : String(error)}` };
      reasons.push("evaluator output unparseable");
    }
  }

  const dir = await mkdtemp(path.join(tmpdir(), "n33-accept-"));
  const focusedJson = path.join(dir, "focused.json");
  const fullJson = path.join(dir, "full.json");

  const focused = runGate(
    `npx vitest run ${N33_FOCUSED_FILES.join(" ")} --reporter=json --outputFile ${focusedJson} --hookTimeout 60000 --testTimeout 120000`,
    { cwd: repoRoot, unavailableReason: unavailable("toolchain") ?? unavailable("docker"), timeoutMs: 3_600_000 },
  );
  let focusedAssertions: VitestAssertion[] = [];
  if (focused.started) {
    try {
      focusedAssertions = collectVitestAssertions(JSON.parse(await readFile(focusedJson, "utf8")), repoRoot);
      const totals = summarizeVitest(focusedAssertions);
      const skips = buildSkipManifest(focusedAssertions);
      gates.focused = gateJson("focused", focused.started, focused.exitCode, totals.skipped, totals.failed, `files=${totals.files} tests=${totals.tests} passed=${totals.passed}`);
      if (skips.length > 0) reasons.push(`focused skip manifest not empty: ${JSON.stringify(skips)}`);
    } catch (error) {
      gates.focused = gateJson("focused", focused.started, focused.exitCode, 0, 0, `json unparseable: ${error instanceof Error ? error.message : String(error)}`);
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
      const expected = JSON.stringify(N33_ACCEPTED_FULL_SKIPS);
      const actual = JSON.stringify(skips);
      gates.full = gateJson("full", full.started, full.exitCode, totals.skipped, totals.failed, `files=${totals.files} tests=${totals.tests} passed=${totals.passed}`);
      if (actual !== expected) reasons.push(`full skip manifest changed: ${actual}`);
    } catch (error) {
      gates.full = gateJson("full", full.started, full.exitCode, 0, 0, `json unparseable: ${error instanceof Error ? error.message : String(error)}`);
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

  // started non-zero gates are NO-GO; only pre-start unavailability is EVALUATION-INCOMPLETE
  if (focused.started && focused.exitCode !== 0) reasons.push(`focused: exit=${String(focused.exitCode)}`);
  if (full.started && full.exitCode !== 0) reasons.push(`full: exit=${String(full.exitCode)}`);
  for (const gate of ["lint", "build"] as const) {
    const g = gates[gate];
    if (g.exitCode !== 0 && !reasons.some((r) => r === `${gate} unavailable: EVALUATION-INCOMPLETE`)) reasons.push(`${gate} non-zero`);
  }

  const n30Path = path.join(repoRoot, "docs/pth/n30-runtime-observatory-envelope.json");
  let n30Decision: string | undefined;
  try {
    n30Decision = (JSON.parse(await readFile(n30Path, "utf8")) as { decision?: string }).decision;
  } catch { /* missing */ }
  if (n30Decision !== "GO") {
    gates.n30Envelope = { exitCode: 1, note: n30Decision ? `present but decision=${n30Decision}` : "missing (EVALUATION-INCOMPLETE)" };
    reasons.push("N30 envelope not GO: EVALUATION-INCOMPLETE");
  } else {
    gates.n30Envelope = { exitCode: 0, note: "GO" };
  }

  const decision = reasons.length === 0 ? "GO"
    : reasons.every((r) => r.includes("EVALUATION-INCOMPLETE")) ? "EVALUATION-INCOMPLETE"
    : "NO-GO";

  const envelope = {
    schema: "n33-operator-console-acceptance/1",
    generatedAt: new Date().toISOString(),
    plan: "docs/superpowers/plans/2026-08-19-v13-ptl-operator-console.md",
    evaluatedCommit: head,
    implementationTreeClean: clean,
    decision,
    gates,
    reasons,
    skipManifest: { allowed: N33_ACCEPTED_FULL_SKIPS, observed: gates.full?.skipped ?? null },
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
