/**
 * accept-n33-operator-console.ts — N33 权威验收驱动。
 *
 * 记录 evaluated commit、clean tree、eval 双跑字节一致、focused/full/lint/build
 * 与 N30 envelope 存在性、N29 非回归（full 零 fail、skip manifest 无新增）。
 * 任一已启动门非零 = NO-GO；必需服务不可用 = EVALUATION-INCOMPLETE。
 * 输出 envelope JSON（--output <path>，缺省 stdout）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = new URL("..", import.meta.url);
const repo = fileURLToPath(root);

function git(args: string): string {
  return execFileSync("git", args.split(" "), { cwd: repo, encoding: "utf8" }).trim();
}

function run(label: string, cmd: string, args: string[]): { exitCode: number; skipped: number; failed: number } {
  const stdout = execFileSync(cmd, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const files = (stdout.match(/Test Files\s+\d+ passed \|\s*\d+ skipped/) ?? [""])[0] ?? "";
  const tests = (stdout.match(/Tests\s+\d+ passed \|\s*\d+ skipped/) ?? [""])[0] ?? "";
  const failed = (stdout.match(/(\d+) failed/) ?? [])[1] ?? "0";
  const skipped = (stdout.match(/(\d+) skipped/) ?? [])[1] ?? "0";
  return { exitCode: 0, skipped: Number(skipped), failed: Number(failed) };
}

interface GateResult { exitCode: number; note: string }

const gates: Record<string, GateResult> = {};
const reasons: string[] = [];

try {
  const status = git("status --porcelain");
  if (status !== "") {
    gates.cleanTree = { exitCode: 1, note: "tree dirty" };
    reasons.push("implementation tree is not clean");
  } else {
    gates.cleanTree = { exitCode: 0, note: "clean" };
  }
  gates.evaluatedCommit = { exitCode: 0, note: git("rev-parse HEAD") };

  const evalOut1 = execFileSync("node", ["--import", "tsx", "scripts/eval-n33-operator-console.ts"], { cwd: repo, encoding: "utf8" });
  const evalOut2 = execFileSync("node", ["--import", "tsx", "scripts/eval-n33-operator-console.ts"], { cwd: repo, encoding: "utf8" });
  if (evalOut1 !== evalOut2) {
    gates.evaluator = { exitCode: 1, note: "evaluator not byte-identical across two runs" };
    reasons.push("evaluator not byte-identical");
  } else {
    const parsed = JSON.parse(evalOut1) as { decision?: string; denominators?: Record<string, unknown> };
    if (parsed.decision !== "PASS") {
      gates.evaluator = { exitCode: 1, note: `decision ${parsed.decision}` };
      reasons.push(`evaluator decision ${parsed.decision}`);
    } else {
      gates.evaluator = { exitCode: 0, note: JSON.stringify(parsed.denominators) };
    }
  }
} catch (error) {
  gates.evaluator = { exitCode: 1, note: error instanceof Error ? error.message : String(error) };
  reasons.push("evaluator crashed");
}

const focused = run("focused", "npx", ["vitest", "run",
  "test/unit/operator-console-*.test.ts",
  "test/pth-contracts/system-inspection.test.ts",
  "test/pth-application/system-inspection-facade.pg.test.ts",
  "test/pth-gateway/system-inspection-routes.test.ts",
  "test/pth-gateway/intake-routes.test.ts",
  "test/pth-composition/operator-console-*.test.ts",
  "--hookTimeout", "60000", "--testTimeout", "120000"]);
gates.focused = { exitCode: focused.failed > 0 ? 1 : 0, note: `failed=${focused.failed} skipped=${focused.skipped}` };
if (focused.failed > 0 || focused.skipped > 0) reasons.push("focused regression not clean");

const full = run("full", "npx", ["vitest", "run", "--hookTimeout", "60000"]);
gates.full = { exitCode: full.failed > 0 ? 1 : 0, note: `failed=${full.failed} skipped=${full.skipped}` };
if (full.failed > 0) reasons.push("full regression has failures");
if (full.skipped > 9) reasons.push("skip manifest grew");

for (const gate of ["lint", "build"] as const) {
  try {
    execFileSync("npm", ["run", gate], { cwd: repo, stdio: "ignore" });
    gates[gate] = { exitCode: 0, note: "ok" };
  } catch {
    gates[gate] = { exitCode: 1, note: "non-zero" };
    reasons.push(`${gate} non-zero`);
  }
}

const n30Envelope = existsSync(fileURLToPath(new URL("docs/pth/n30-runtime-observatory-envelope.json", root)));
gates.n30Envelope = { exitCode: n30Envelope ? 0 : 1, note: n30Envelope ? "present" : "missing (EVALUATION-INCOMPLETE)" };
if (!n30Envelope) reasons.push("N30 envelope missing: EVALUATION-INCOMPLETE");

const decision = reasons.length === 0 ? "GO" : reasons.every((r) => r.includes("EVALUATION-INCOMPLETE")) ? "EVALUATION-INCOMPLETE" : "NO-GO";

const envelope = {
  schemaVersion: 1,
  decision,
  evaluatedCommit: gates.evaluatedCommit.note,
  generatedBy: "accept-n33-operator-console",
  gates,
  reasons,
  skipManifest: { allowed: ["test/pth-execution/sandbox-security.integration.test.ts"], observed: full.skipped },
  sha256: createHash("sha256").update(JSON.stringify({ decision, evaluatedCommit: gates.evaluatedCommit.note, reasons })).digest("hex"),
};

const outputArg = process.argv.indexOf("--output");
const body = JSON.stringify(envelope, null, 2);
if (outputArg >= 0 && process.argv[outputArg + 1]) {
  writeFileSync(fileURLToPath(new URL(process.argv[outputArg + 1]!, root)), body + "\n");
} else {
  console.log(body);
}
process.exit(decision === "GO" ? 0 : 1);
