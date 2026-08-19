/**
 * scripts/update-professional-runtime-lock.ts — 探测预装专业运行时并写 committed lock。
 *
 * 运行方式：`npx tsx scripts/update-professional-runtime-lock.ts`
 *
 * 规则：
 *  - 只接受 stable 版本；prerelease/nightly/dev/alpha/beta/rc/snapshot 标识一律拒绝；
 *  - 每个工具从 `--version` 输出中按精确正则捕获版本号（不猜、不截取 shell 文本）；
 *  - 任一工具缺失/版本无法解析时整单失败，不写出半成品 lock；
 *  - 写出排序 canonical JSON（键按字典序、runtimes 按 runtime id 字典序）。
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ProfessionalRuntimeId,
  ProfessionalRuntimeLock,
} from "../src/pth/contracts/professional-computing.js";

const LOCK_PATH = fileURLToPath(new URL("../deploy/professional-runtime-lock.json", import.meta.url));

const REJECT_VERSION_RE = /(?:pre|rc|alpha|beta|nightly|dev|snapshot|preview)/i;

interface ProbeSpec {
  readonly runtimeId: ProfessionalRuntimeId;
  readonly tool: string;
  readonly args: readonly string[];
  readonly extract: RegExp;
}

const PROBES: readonly ProbeSpec[] = [
  {
    runtimeId: "assembly",
    tool: "as",
    args: ["--version"],
    extract: /GNU assembler \([^)]*\) ([0-9]+\.[0-9]+(?:\.[0-9]+)?)/,
  },
  {
    runtimeId: "lean4",
    tool: "lean",
    args: ["--version"],
    extract: /Lean \(version ([0-9]+\.[0-9]+\.[0-9]+)/,
  },
  {
    runtimeId: "wolfram",
    tool: "wolframscript",
    args: ["-version"],
    extract: /WolframScript ([0-9]+\.[0-9]+\.[0-9]+)/,
  },
  {
    runtimeId: "psi4",
    tool: "psi4",
    args: ["--version"],
    extract: /([0-9]+\.[0-9]+\.[0-9]+)/,
  },
  {
    runtimeId: "quantum-espresso",
    tool: "pw.x",
    args: ["--version"],
    extract: /([0-9]+\.[0-9]+\.[0-9]+)/,
  },
  {
    runtimeId: "jupyter",
    tool: "jupyter-notebook",
    args: ["--version"],
    extract: /([0-9]+\.[0-9]+\.[0-9]+)/,
  },
];

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stable((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function probeVersion(spec: ProbeSpec): string {
  const stdout = execFileSync(spec.tool, [...spec.args], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const match = stdout.match(spec.extract);
  if (!match) {
    throw new Error(`${spec.runtimeId}: cannot extract exact version from ${spec.tool} output`);
  }
  const version = (match[1] ?? match[0]).trim();
  if (REJECT_VERSION_RE.test(version)) {
    throw new Error(`${spec.runtimeId}: prerelease/nightly/dev version rejected: ${version}`);
  }
  return version;
}

function main(): void {
  const runtimes = {} as Record<ProfessionalRuntimeId, ProfessionalRuntimeLock["runtimes"][ProfessionalRuntimeId]>;
  for (const spec of PROBES) {
    const version = probeVersion(spec);
    runtimes[spec.runtimeId] = {
      version,
      releaseChannel: "stable",
      probe: {
        tool: spec.tool,
        args: [...spec.args],
        extract: spec.extract.source,
      },
    };
  }
  const lock: ProfessionalRuntimeLock = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtimes,
  };
  writeFileSync(LOCK_PATH, canonicalJson(lock), "utf8");
  console.log(`[professional-runtime-lock] wrote ${LOCK_PATH}`);
}

try {
  main();
} catch (error) {
  console.error(`[professional-runtime-lock] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
