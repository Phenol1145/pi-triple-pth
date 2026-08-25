/**
 * scripts/eval/eval-v13-professional-computing.ts —— v1.3 Task 10 权威评测器（确定性）。
 *
 * 只读文件系统 + 纯函数：同一 commit 连跑两次必须字节一致（本脚本内部自证）。
 * 精确分母：五类记忆 / committed lock adapters / 四个真实源 Job / 四份教程 /
 * 组合测试授权探针 / 12 项 sabotage probe。任一非正分母或任一 probe 未翻转 = NO-GO。
 * N29/N30/N33 envelope 缺失 = EVALUATION-INCOMPLETE（环境未就绪，不伪造）。
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { MEMORY_TYPES, type ProfessionalRuntimeLock } from "@away_from/pth-contracts";
import { runV13SabotageProbes } from "../tools/v13-authority-gates.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const p = (rel: string) => path.join(repoRoot, rel);

function readText(rel: string): string {
  return readFileSync(p(rel), "utf8");
}

function countOccurrences(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function readEnvelope(rel: string): { decision?: string } | null {
  try {
    return JSON.parse(readFileSync(p(rel), "utf8")) as { decision?: string };
  } catch {
    return null;
  }
}

export function evaluateV13ProfessionalComputing(): {
  schemaVersion: number;
  decision: "PASS" | "NO-GO" | "EVALUATION-INCOMPLETE";
  denominators: Record<string, unknown>;
  envelopes: Record<string, { decision: string | null; satisfied: boolean }>;
  sabotage: ReturnType<typeof runV13SabotageProbes>;
  reasons: string[];
  sha256: string;
} {
  const reasons: string[] = [];

  const lock = JSON.parse(readText("deploy/professional-runtime-lock.json")) as ProfessionalRuntimeLock;
  const adapterIds = Object.keys(lock.runtimes).sort();

  const educatorTest = existsSync(p("test/pth-professional/technical-educator.integration.test.ts"))
    ? readText("test/pth-professional/technical-educator.integration.test.ts")
    : "";
  const compositionTest = existsSync(p("test/pth-composition/v13-professional-computing.test.ts"))
    ? readText("test/pth-composition/v13-professional-computing.test.ts")
    : "";

  const realJobCases = countOccurrences(educatorTest, /it\("(assembly|lean4|chemistry|wolfram): .*真实/g);
  const notebooks = countOccurrences(educatorTest, /it\("(assembly|lean4|chemistry|wolfram) 教程草稿 \+ manifest 绑定/g);
  const authorizationProbes = countOccurrences(compositionTest, /it\("/g);

  const sabotage = runV13SabotageProbes();
  const failedProbes = sabotage.filter((probe) => !probe.flipped);

  const n29 = readEnvelope("docs/pth/n29-minimal-intake-acceptance.json");
  const n30 = readEnvelope("docs/pth/n30-runtime-observatory-envelope.json");
  const n33 = readEnvelope("docs/pth/n33-operator-console-envelope.json");

  const n29Satisfied = n29?.decision === "MIN_INNER_LOOP_GO" || n29?.decision === "GO";
  const n30Satisfied = n30?.decision === "GO";
  const n33Satisfied = n33?.decision === "GO";
  const envelopes = {
    n29: { decision: n29?.decision ?? null, satisfied: n29Satisfied },
    n30: { decision: n30?.decision ?? null, satisfied: n30Satisfied },
    n33: { decision: n33?.decision ?? null, satisfied: n33Satisfied },
  };

  const denominators = {
    memoryTypes: MEMORY_TYPES.length,
    adapters: adapterIds.length,
    realJobCases,
    notebooks,
    authorizationProbes,
    sabotageProbes: sabotage.length,
  };

  for (const [key, value] of Object.entries(denominators)) {
    if (typeof value === "number" && (!Number.isFinite(value) || value <= 0)) {
      reasons.push(`denominator ${key} is not a positive integer: ${value}`);
    }
  }
  for (const probe of failedProbes) {
    reasons.push(`sabotage probe ${probe.gate} did not flip (base=${probe.baseOk}, sabotaged=${probe.sabotagedOk})`);
  }
  if (!n29Satisfied) reasons.push("N29 envelope not MIN_INNER_LOOP_GO/GO: EVALUATION-INCOMPLETE");
  if (!n30Satisfied) reasons.push("N30 envelope not GO: EVALUATION-INCOMPLETE");
  if (!n33Satisfied) reasons.push("N33 envelope not GO: EVALUATION-INCOMPLETE");
  if (!existsSync(p("test/pth-professional/technical-educator.integration.test.ts"))) reasons.push("technical-educator real suite missing");
  if (!existsSync(p("test/pth-composition/v13-professional-computing.test.ts"))) reasons.push("v13 composition test missing");

  const decision: "PASS" | "NO-GO" | "EVALUATION-INCOMPLETE" = reasons.length === 0
    ? "PASS"
    : reasons.every((r) => r.includes("EVALUATION-INCOMPLETE"))
      ? "EVALUATION-INCOMPLETE"
      : "NO-GO";

  const payload = {
    schemaVersion: 1,
    decision,
    denominators,
    envelopes,
    sabotage,
    reasons,
    sha256: "",
  };
  const canonical = JSON.stringify(payload, null, 2);
  const digest = createHash("sha256").update(canonical).digest("hex");
  return { ...payload, sha256: digest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const first = JSON.stringify(evaluateV13ProfessionalComputing(), null, 2);
  const second = JSON.stringify(evaluateV13ProfessionalComputing(), null, 2);
  if (first !== second) {
    process.stderr.write("evaluator is not deterministic\n");
    process.exit(1);
  }
  process.stdout.write(first);
  process.exit(0);
}
