/**
 * check-role-conservation.ts —— Q9：角色能力守恒静态校验器（三源重构 W4）。
 *
 * 规则：
 *  - L1（覆盖守恒，分枝校验）：同一 family（actuator/sensor/controller 三枝）内，
 *    相邻 generation 的 effcap 并集应严格相等。默认输出质量报告；
 *    传 `--strict` 时不等即 fail-fast（口径稳定后接入 lint 硬档）。
 *  - L2（细化单调，硬校验）：cap(child) ⊆ effcap(parent)，倒挂即 fail。
 *  - produces 合法性（硬校验）：produces 必须是 string[]（允许空数组=禁止写；undefined=不限）。
 *
 * 用法：npm run check:role-conservation [--strict]
 */

import type { WorkerRole } from "@away_from/pth-kernel-execution";
import { loadDefaultRoleSets } from "../src/pth/catalog/index.js";

const { defaultRoles, midRoles, governanceRoles, professionalRoles } = loadDefaultRoleSets();
const ALL_ROLES: WorkerRole[] = [...defaultRoles, ...midRoles, ...governanceRoles, ...professionalRoles];

const ROOTS = new Set(["actuator", "sensor", "controller"]);

function capSet(r: WorkerRole): Set<string> {
  return new Set(r.capabilities ?? []);
}

function rootOf(r: WorkerRole, byId: Map<string, WorkerRole>): string {
  let cur = r;
  const seen = new Set<string>();
  while (cur.parent && byId.has(cur.parent) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parent)!;
  }
  return cur.id;
}

function main(): void {
  const strict = process.argv.includes("--strict");
  const byId = new Map(ALL_ROLES.map((r) => [r.id, r]));
  const childrenOf = new Map<string, string[]>();
  for (const r of ALL_ROLES) {
    if (r.parent && byId.has(r.parent)) {
      const list = childrenOf.get(r.parent) ?? [];
      list.push(r.id);
      childrenOf.set(r.parent, list);
    }
  }

  const descendants = (id: string): string[] => {
    const out: string[] = [];
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const c of childrenOf.get(cur) ?? []) {
        if (!out.includes(c)) {
          out.push(c);
          queue.push(c);
        }
      }
    }
    return out;
  };

  const effcap = (id: string): Set<string> => {
    const role = byId.get(id);
    if (!role) return new Set();
    const out = capSet(role);
    for (const d of descendants(id)) {
      const dRole = byId.get(d);
      if (dRole) for (const c of capSet(dRole)) out.add(c);
    }
    return out;
  };

  const errors: string[] = [];
  const reports: string[] = [];

  // L2：子能力 ⊂ 父 effcap（硬）
  for (const r of ALL_ROLES) {
    if (!r.parent || !byId.has(r.parent)) continue;
    const child = capSet(r);
    const parentEff = effcap(r.parent);
    const missing = [...child].filter((c) => !parentEff.has(c));
    if (missing.length > 0) {
      errors.push(`L2 倒挂：${r.id} 能力 ${missing.join(",")} 不在父 ${r.parent} effcap 中`);
    }
  }

  // produces 合法性（硬）
  for (const r of ALL_ROLES) {
    if (r.produces === undefined) continue;
    if (!Array.isArray(r.produces) || r.produces.some((k) => typeof k !== "string" || k.trim() === "")) {
      errors.push(`produces 非法：${r.id} produces 必须是 string[]（非空字符串）`);
    }
  }

  // L1 分枝报告（默认报告；--strict 才 fail）
  const branches = new Map<string, Map<number, Set<string>>>();
  for (const r of ALL_ROLES) {
    const root = rootOf(r, byId);
    if (!ROOTS.has(root)) continue;
    const gen = r.generation ?? 0;
    const byGen = branches.get(root) ?? new Map<number, Set<string>>();
    const union = byGen.get(gen) ?? new Set<string>();
    for (const c of effcap(r.id)) union.add(c);
    byGen.set(gen, union);
    branches.set(root, byGen);
  }
  for (const [root, byGen] of [...branches.entries()].sort()) {
    const gens = [...byGen.keys()].sort((a, b) => a - b);
    for (let i = 0; i < gens.length - 1; i++) {
      const g = gens[i]!;
      const next = gens[i + 1]!;
      const cur = byGen.get(g)!;
      const nxt = byGen.get(next)!;
      const equal = cur.size === nxt.size && [...cur].every((x) => nxt.has(x));
      const msg = `L1 分枝 ${root}: gen${g} effcap∪(${cur.size}) ${equal ? "=" : "≠"} gen${next} effcap∪(${nxt.size})`;
      reports.push(msg);
      if (strict && !equal) errors.push(msg);
    }
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(`  ❌ ${e}`);
    console.error(`── role-conservation：${errors.length} 条违规 ──`);
    process.exit(1);
  }
  console.log(`── role-conservation：L2/produces 硬校验通过 · L1 分枝报告 ${reports.length} 条${strict ? "（strict）" : "（报告档）"} ──`);
  for (const r of reports) console.log(`  ${r}`);
  console.log("✅ role-conservation 检查通过");
}

main();
