#!/usr/bin/env node
/**
 * n14-p3-tool-promotion.ts —— N14 P3 晋升管线首跑脚本（2026-08-18）。
 *
 * 用途：把 memory_entries 中真实的 tool-function 候选（refiner 沉淀物）经完整治理流
 * 晋升为 tool-reg 条目——即「1-2 个真实 tool-function 晋升验证」的证据脚本：
 *   ① 从 DB 读真实 tool-function（status=official）；
 *   ② 包装为 tool-reg spec（program 态：函数声明 + args 调用缝；描述三要素来自候选语义）；
 *   ③ 走 §3.4 治理流：propose → controller:adversarial review(pass) → 监督批准 → execute；
 *   ④ ts 核真实执行验证（TsInterpreter——与 agent-loop program 执行缝同款解释器）；
 *   ⑤ 快照可见性验证（loadToolRegSnapshot——official 才进面）。
 *
 * 用法（仓库根）：
 *   DATABASE_URL=… npx tsx scripts/n14-p3-tool-promotion.ts            # 真跑（写库）
 *   DATABASE_URL=… npx tsx scripts/n14-p3-tool-promotion.ts --dry-run  # 只验证不写库
 *   DATABASE_URL=… npx tsx scripts/n14-p3-tool-promotion.ts --candidate fn-wx7wk7
 *
 * 幂等：目标 tool-reg 已存在（official）时跳过注册，仍做执行验证；提案 UUID 每次全新。
 * 注意：本脚本只用于首跑验证；日常晋升由 controller:tool-face 经 manage.tool.register 完成。
 */

import pg from "pg";
import { PgMemoryStore } from "../packages/pth-memory/src/memory-store-pg.ts";
import {
  proposeToolRegistration,
  reviewToolProposal,
  approveToolProposal,
  executeApprovedToolProposal,
  validateToolRegSpec,
  type ToolRegSpec,
} from "../packages/pth-memory/src/tool-reg.ts";
import { TsInterpreter } from "../src/pth/impls/kernels/ts-interpreter.ts";

interface Candidate {
  /** 真实 tool-function 条目 id */
  toolFunctionId: string;
  /** 晋升后的工具名（去点/下划线形） */
  name: string;
  description: { anchor: string; whenToUse: string; effect: string };
  /** OpenAI function 参数契约（与候选函数签名对齐） */
  properties: Record<string, unknown>;
  required: string[];
  /** args.<key> 调用表达式（执行缝尾部 return） */
  call: string;
  /** 执行验证样例 */
  verifyArgs: Record<string, unknown>;
  /** 执行验证断言（返回 JSON 深包含匹配） */
  verifyContains?: Record<string, unknown>;
  roles: string[];
}

const CANDIDATES: Candidate[] = [
  {
    toolFunctionId: "fn-wx7wk7",
    name: "toolfn_anchor_stats",
    description: {
      anchor: "统计记忆条目的锚点数量分布与高频锚点",
      whenToUse: "需要对一组记忆条目做锚点覆盖/重复度体检时（sensor:memory 数据加工）",
      effect: "返回 { total, withAnchors, countDist, topAnchors }",
    },
    properties: { rows: { type: "array", items: { type: "object" } } },
    required: ["rows"],
    call: "anchorStats(args.rows)",
    verifyArgs: { rows: [{ anchors: ["a", "b"] }, { anchors: ["a", "c"] }, { anchors: [] }] },
    verifyContains: { total: 3, withAnchors: 2 },
    roles: ["developer", "coder"],
  },
  {
    toolFunctionId: "fn-v2u2if",
    name: "toolfn_anchors_of",
    description: {
      anchor: "把任意形态的锚点值归一化为字符串数组",
      whenToUse: "锚点可能以逗号字符串/数组/JSON 形式出现，需要统一读取时",
      effect: "返回去空格的字符串数组（非法值回空数组）",
    },
    properties: { anchorValue: { type: "string" } },
    required: ["anchorValue"],
    call: "anchorsOf(args.anchorValue)",
    verifyArgs: { anchorValue: "a, b, a" },
    verifyContains: {},
    roles: ["developer", "coder"],
  },
];

const dryRun = process.argv.includes("--dry-run");
const onlyId = process.argv.find((a) => a.startsWith("--candidate="))?.split("=")[1];
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("缺少 DATABASE_URL（compose 已配）");
  process.exit(1);
}

function deepContains(actual: unknown, expected: Record<string, unknown>): boolean {
  if (typeof actual !== "object" || actual === null) return false;
  return Object.entries(expected).every(([k, v]) => {
    if (typeof v === "object" && v !== null) return deepContains((actual as Record<string, unknown>)[k], v);
    return (actual as Record<string, unknown>)[k] === v;
  });
}

const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
const store = new PgMemoryStore(pool);

const candidates = onlyId ? CANDIDATES.filter((c) => c.toolFunctionId === onlyId) : CANDIDATES;
if (candidates.length === 0) {
  console.error(`候选不存在：${onlyId}`);
  process.exit(1);
}

let promoted = 0;
let skipped = 0;
try {
  for (const c of candidates) {
    console.log(`\n── 候选 ${c.toolFunctionId} → tool:${c.name}${dryRun ? "（dry-run）" : ""} ──`);
    const tf = await store.get(c.toolFunctionId);
    if (!tf || tf.kind !== "tool-function" || tf.status !== "official") {
      console.error(`✗ 真实 tool-function 不存在或非 official：${c.toolFunctionId}`);
      process.exitCode = 1;
      continue;
    }
    const source = tf.content;
    const spec: ToolRegSpec = {
      name: c.name,
      version: 1,
      description: c.description,
      parameters: { type: "object", properties: c.properties, required: c.required },
      executor: { type: "program", source: `${source}\nreturn ${c.call};` },
      visibility: { roles: c.roles, pack: "util" },
      promotedFrom: `tool-function:${c.toolFunctionId}`,
    };
    const checked = validateToolRegSpec(spec);
    if (!checked.ok) {
      console.error(`✗ spec 包装失败：${checked.error}`);
      process.exitCode = 1;
      continue;
    }

    // ① ts 核真实执行验证（agent-loop program 执行缝同款解释器）
    const interpreter = new TsInterpreter({ capabilities: {} });
    const program = `const args = ${JSON.stringify(c.verifyArgs)};\n${spec.executor.type === "program" ? spec.executor.source : ""}`;
    const exec = await interpreter.execute(program, { exec: "program" });
    if (!exec.ok || exec.value === undefined) {
      console.error(`✗ ts 核执行验证失败：${exec.ok ? "无返回值" : JSON.stringify(exec.error)}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`✓ ts 核执行验证通过（${exec.durationMs}ms）：${JSON.stringify(exec.value).slice(0, 160)}`);
    if (Object.keys(c.verifyContains ?? {}).length > 0 && !deepContains(exec.value, c.verifyContains!)) {
      console.error(`✗ 执行结果不满足断言：${JSON.stringify(exec.value)}`);
      process.exitCode = 1;
      continue;
    }

    if (dryRun) continue;

    // ② 治理流：propose → adversarial review(pass) → 监督批准 → execute
    const proposal = await proposeToolRegistration(store, { action: "register", name: spec.name, spec, rationale: `首跑晋升：真实 tool-function ${c.toolFunctionId}` });
    if (!proposal.ok) {
      // 幂等：首跑已完成 → 条目已存在
      const existing = await store.get(`tool:${spec.name}`);
      if (existing?.status === "official") {
        console.log(`↷ 已存在（幂等跳过注册）——tool:${spec.name} v${existing.meta?.version}`);
        skipped++;
        continue;
      }
      console.error(`✗ 提案失败：${proposal.error}`);
      process.exitCode = 1;
      continue;
    }
    const review = await reviewToolProposal(store, proposal.id!, "pass", "首跑：schema 与签名对齐 / 执行体为纯函数无副作用 / 无作弊捷径");
    if (!review.ok) {
      console.error(`✗ 对抗性审核失败：${review.error}`);
      process.exitCode = 1;
      continue;
    }
    const approved = await approveToolProposal(store, proposal.id!);
    if (!approved.ok) {
      console.error(`✗ 监督批准失败：${approved.error}`);
      process.exitCode = 1;
      continue;
    }
    const executed = await executeApprovedToolProposal(store, proposal.id!);
    if (!executed.ok) {
      console.error(`✗ 注册执行失败：${executed.error}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`✓ 晋升落库：${executed.id}（proposal=${proposal.id}）`);
    promoted++;

    // ③ 快照可见性验证（official 才进面——§7-4）
    const { loadToolRegSnapshot } = await import("@away_from/pth-kernel-execution");
    const snap = await loadToolRegSnapshot(store);
    const inFace = snap.entries.has(spec.name) && snap.entries.get(spec.name)!.visibility.roles.includes("developer");
    console.log(`${inFace ? "✓" : "✗"} 快照可见性：${snap.version} ${inFace ? `含 ${spec.name}` : `缺 ${spec.name}`}`);
    if (!inFace) process.exitCode = 1;
  }
  console.log(`\n结果：promoted=${promoted} skipped=${skipped} dryRun=${dryRun}`);
} finally {
  await pool.end();
}
