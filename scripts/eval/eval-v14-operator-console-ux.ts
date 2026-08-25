/**
 * scripts/eval/eval-v14-operator-console-ux.ts —— v1.4 权威评测器（确定性）。
 *
 * 分母：
 *  - 5 页模块 · 12+ UI primitives · 设计 token/可访问性契约
 *  - Vite manifest 文件数与 digest 一致性
 *  - 真实 loopback HTTP module graph
 *  - secret 上游错误探针
 *  - N29/N30/N33 envelope 决策
 * 同一 commit 双跑必须字节一致；任何非正分母或泄漏 >0 = NO-GO。
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { runV14RealProbes } from "../tools/v14-real-probes.js";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const PAGE_IDS = ["overview", "work", "debug", "memory", "config"] as const;
const UI_PRIMITIVES = ["Button", "Badge", "Card", "PageHeader", "Tabs", "Table", "Dialog", "Skeleton", "EmptyState", "ErrorState", "Pagination", "Progress", "Toaster"] as const;

function readEnvelope(rel: string): { decision?: string } | null {
  try {
    return JSON.parse(read(rel)) as { decision?: string };
  } catch {
    return null;
  }
}

export async function evaluateV14OperatorConsoleUx(): Promise<{
  decision: "PASS" | "NO-GO" | "EVALUATION-INCOMPLETE";
  denominators: Record<string, unknown>;
  reasons: string[];
  sha256: string;
}> {
  const reasons: string[] = [];
  const styles = read("packages/pth-console/web-src/src/styles.css");
  const ui = read("packages/pth-console/web-src/src/ui.tsx");
  const toast = existsSync(path.join(root, "packages/pth-console/web-src/src/toast.tsx"))
    ? read("packages/pth-console/web-src/src/toast.tsx")
    : "";

  const pages = PAGE_IDS.filter((id) =>
    existsSync(path.join(root, `packages/pth-console/web-src/src/pages/${id}.tsx`)),
  );
  const primitives = UI_PRIMITIVES.filter((name) =>
    ui.includes(`export function ${name}`) || toast.includes(`export function ${name}`),
  );
  const tokens = {
    colorScheme: styles.includes("color-scheme"),
    lightDark: styles.includes("light-dark("),
    focusVisible: styles.includes(":focus-visible"),
    reducedMotion: styles.includes("prefers-reduced-motion"),
  };
  const forbidden = /dangerouslySetInnerHTML|innerHTML\s*=|document\.write/.test(ui + toast + read("packages/pth-console/web-src/src/app.tsx"));

  const realProbes = await runV14RealProbes();
  const n29 = readEnvelope("docs/pth/n29-minimal-intake-acceptance.json");
  const n30 = readEnvelope("docs/pth/n30-runtime-observatory-envelope.json");
  const n33 = readEnvelope("docs/pth/n33-operator-console-envelope.json");

  const denominators = {
    pages: pages.length,
    uiPrimitives: primitives.length,
    designTokens: Object.values(tokens).filter(Boolean).length,
    manifestFiles: realProbes.manifest.files,
    manifestDigestsOk: realProbes.manifest.digestsOk,
    moduleGraphServed: realProbes.moduleGraph.servedAssets,
    upstreamErrors: realProbes.secretBoundary.upstreamErrors,
    requestIds: realProbes.secretBoundary.requestIds,
    leakedSentinels: realProbes.secretBoundary.leakedSentinelCount,
  };

  if (pages.length !== 5) reasons.push(`pages ${pages.length} != 5`);
  if (primitives.length < 12) reasons.push(`ui primitives ${primitives.length} < 12`);
  for (const [name, ok] of Object.entries(tokens)) if (!ok) reasons.push(`design token missing: ${name}`);
  if (forbidden) reasons.push("forbidden innerHTML rendering detected");
  if (!realProbes.manifest.hasEntry || !realProbes.manifest.hasCss || !realProbes.manifest.hasIndexJs) {
    reasons.push("vite manifest missing required entries");
  }
  if (realProbes.manifest.files < 4) reasons.push(`vite manifest files ${realProbes.manifest.files} < 4`);
  if (realProbes.manifest.digestsOk !== realProbes.manifest.files) {
    reasons.push(`manifest digests ${realProbes.manifest.digestsOk}/${realProbes.manifest.files}`);
  }
  if (realProbes.moduleGraph.servedAssets !== realProbes.moduleGraph.expectedAssets) {
    reasons.push(`module graph ${realProbes.moduleGraph.servedAssets}/${realProbes.moduleGraph.expectedAssets}`);
  }
  if (realProbes.secretBoundary.upstreamErrors !== 3) reasons.push(`upstream error probes ${realProbes.secretBoundary.upstreamErrors} != 3`);
  if (realProbes.secretBoundary.requestIds !== 3) reasons.push(`request ids ${realProbes.secretBoundary.requestIds} != 3`);
  if (realProbes.secretBoundary.leakedSentinelCount !== 0) reasons.push(`leaked sentinel count ${realProbes.secretBoundary.leakedSentinelCount} != 0`);
  if (n29?.decision !== "MIN_INNER_LOOP_GO" && n29?.decision !== "GO") reasons.push("N29 envelope not GO: EVALUATION-INCOMPLETE");
  if (n30?.decision !== "GO") reasons.push("N30 envelope not GO: EVALUATION-INCOMPLETE");
  if (n33?.decision !== "GO") reasons.push("N33 envelope not GO: EVALUATION-INCOMPLETE");

  const decision = reasons.length === 0
    ? "PASS"
    : reasons.every((reason) => reason.includes("EVALUATION-INCOMPLETE"))
      ? "EVALUATION-INCOMPLETE"
      : "NO-GO";

  const payload = { decision, denominators, reasons, sha256: "" };
  const canonical = JSON.stringify(payload, null, 2);
  const digest = createHash("sha256").update(canonical).digest("hex");
  return { ...payload, sha256: digest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const first = JSON.stringify(await evaluateV14OperatorConsoleUx(), null, 2);
  const second = JSON.stringify(await evaluateV14OperatorConsoleUx(), null, 2);
  if (first !== second) {
    process.stderr.write("evaluator is not deterministic\n");
    process.exit(1);
  }
  process.stdout.write(first);
  process.exit(0);
}
