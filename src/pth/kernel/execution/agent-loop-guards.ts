/**
 * agent-loop-guards.ts —— 动作指纹/负结果收敛/环境预置（模块专项 ② 大文件拆分：自 agent-loop.ts 抽出）。
 */
export function isTsFamily(tool: string): boolean {
  return tool.replace(/_/g, ".") === "ts.run" || tool.replace(/_/g, ".") === "ts.eval";
}

export function truncate(s: string, max = 2000): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + `…(截断 ${s.length - max} 字符)`, truncated: true };
}

/** 动作指纹（防死锁/重复：连续相同动作检测）
 * 归一化（轨迹分析 2026-08-09——两轮修正）：
 *   ① readSource/readText：同路径 = 重复（模型 14 次微变重写同一 readSource——全量 args
 *      比较被变量名/注释差异绕过——按文件路径判定）
 *   ② memory 查询：同 SQL = 重复（c473e646 实测：无文件读取的 ts 退化 `ts:*` 把不同查询
 *      （role/索引/列表）误判重复——按 SQL 指纹区分）
 *   ③ 其他 ts：code 去空白归一化（微变仍算不同——防误判） */
export function actionFingerprint(tool: string, args: Record<string, unknown>): string {
  if (isTsFamily(tool) && typeof args.code === "string") {
    const code = args.code;
    const reads = [...code.matchAll(/fs\.(readSource|readText)\(\s*"([^"]+)"/g)]
      .map((m) => `${m[1]}:${m[2]}`)
      .sort();
    if (reads.length > 0) return `ts:${reads.join(",")}`;
    const memSqls = [...code.matchAll(/memory\.query\(\s*"([^"]+)"/g)]
      .map((m) => m[1])
      .sort();
    if (memSqls.length > 0) return `ts:mem:${memSqls.join("|")}`;
    return `ts:${code.replace(/\s+/g, " ").slice(0, 200)}`;
  }
  return `${tool}:${JSON.stringify(args)}`;
}
// ── 负结果收敛窗口（S6 死循环机制落地——controller 裁决 2026-08-13）──────────
// 证据：agent-reach 279 步 maxSteps 强制终止，bash_run=174 反复探测 extensions/<name>/index.ts
//       （参数微变绕过参数指纹——同目标不同参数的负验证循环无收敛条件）
// 机制：recentResults 窗口（下限 6 步，随终止阈值动态扩展）按"同工具族+同目标+连续 N 次负结果"判定，
//       N=3 回填引导（该路径已确认不可用→换策略）、N=15 强制终止
//       （2026-08-15 D2 裁决：5→15 放宽——给 sensor 留观测窗口；失败任务尚无正常回收机制，
//       过早强制闭合过于严苛）——与参数指纹并存。
// 窗口下限 6（原 S6 设计）；运行时按 negativeLimits().terminate + 1 动态扩展——
// 阈值可配置（2026-08-15 D2 缺省 15），窗口必须 ≥ 阈值，否则计数永远到不了终止线。
export const RECENT_RESULTS_WINDOW = 6;
// 负结果收敛阈值（N12 护栏统一抽象——配置键 PTH_GUARD_NEGATIVE_LIMIT / PTH_GUARD_NEGATIVE_GUIDE_AT，
// 缺省 15/3——经 guardReg.negativeLimits() 解析后传入 negativeLoopCheck）
const NEG_SEMANTICS = [
  /not found/i, /no such (file|directory)/i, /ENOENT/i, /cannot find/i,
  /不存在/i, /未找到/i, /无此/i, /无法找到/i,
  /failed/i, /failure/i, /失败/i, /\berror\b/i, /错误/i,
  /reject/i, /拒绝/i, /denied/i, /越权/i, /无权/i,
  /不可用/i, /unavailable/i, /invalid/i, /missing/i,
];
export interface RecentAction { family: string; target: string; neg: boolean; }

/** 工具族归一（bash_run/bash_eval→bash；ts_run/ts_eval→ts；fs.*→fs）——负结果按族聚合 */
export function toolFamily(tool: string): string {
  const t = tool.replace(/_/g, ".");
  for (const fam of ["bash", "python", "ts", "fs", "memory", "dev", "debug", "write", "cache"]) {
    if (t === fam || t.startsWith(fam + ".")) return fam;
  }
  return t.split(".")[0];
}

/** 路径模式化：具体文件名/段 → *（保留扩展名与结构）——"同目标不同参数"归一 */
export function normalizePathPattern(p: string): string {
  const segs = p.split("/");
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s || s === "." || s === "..") continue;
    if (/^[A-Za-z0-9_.-]+$/.test(s)) {
      const ext = s.match(/\.([A-Za-z0-9]+)$/);
      segs[i] = ext ? `*.${ext[1]}` : "*";
    }
  }
  return segs.join("/");
}

/** 动作目标提取（语义维度——补参数指纹盲区：同目标不同参数的负验证循环） */
export function actionTarget(tool: string, args: Record<string, unknown>): string {
  const t = tool.replace(/_/g, ".");
  if (typeof args.code === "string") {
    const code = args.code;
    const reads = [...code.matchAll(/fs\.(?:readSource|readText)\(\s*"([^"]+)"/g)].map((m) => m[1]);
    if (reads.length > 0) return `file:${reads.map(normalizePathPattern).sort().join("|")}`;
    const mems = [...code.matchAll(/memory\.query\(\s*"([^"]+)"/g)].map((m) => m[1]);
    if (mems.length > 0) return `mem:${mems.map((s) => s.replace(/[0-9a-fA-F]{8,}/g, "*id*").replace(/\s+/g, " ").slice(0, 80)).sort().join("|")}`;
    return `code:${code.replace(/\s+/g, " ").slice(0, 100)}`;
  }
  const cmd = String(args.command ?? args.cmd ?? "");
  if (cmd) {
    const paths = cmd.match(/[\w./-]+\.(?:ts|js|json|md|txt|py|sh|c|h|yaml|yml)/g) ?? [];
    if (paths.length > 0) return `path:${paths.map(normalizePathPattern).sort().join("|")}`;
    return `cmd:${cmd.replace(/\s+/g, " ").slice(0, 100)}`;
  }
  const pathArg = String(args.path ?? args.relPath ?? "");
  if (pathArg) return `file:${normalizePathPattern(pathArg)}`;
  const sqlArg = String(args.sql ?? "");
  if (sqlArg) return `mem:${sqlArg.replace(/[0-9a-fA-F]{8,}/g, "*id*").replace(/\s+/g, " ").slice(0, 80)}`;
  return `${t}:${JSON.stringify(args).slice(0, 120)}`;
}

/** 负结果语义判定：工具级失败（ok=false）或输出含失败语义（NOT FOUND 等——bash 退出码 0 盲区） */
export function isNegativeResult(result: { ok?: boolean; error?: unknown; stdout?: unknown; value?: unknown } | undefined | null): boolean {
  if (!result) return true;
  if (result.ok === false) return true;
  const text = `${result.error ?? ""} ${result.stdout ?? ""} ${typeof result.value === "string" ? result.value : JSON.stringify(result.value ?? "")}`;
  return NEG_SEMANTICS.some((p) => p.test(text));
}

/** 负结果收敛检查：窗口内同 family+target 的连续负结果计数 → 引导/终止。
 *  阈值走护栏注册表（N12——PTH_GUARD_NEGATIVE_LIMIT/GUIDE_AT，运行时可调）；
 *  allowTerminate=false = 豁免矩阵命中（T5 侦察豁免——guardReg.exempt 判定）。 */
export function negativeLoopCheck(win: RecentAction[], family: string, target: string, neg: boolean, allowTerminate = true, terminateAt = 15, guideAt = 3): { action: "none" | "guide" | "terminate"; count: number } {
  if (!neg) return { action: "none", count: 0 };
  let count = 0;
  for (let i = win.length - 1; i >= 0; i--) {
    const r = win[i];
    if (r.family !== family || r.target !== target) continue;  // 不同目标/工具族不影响该目标计数
    if (!r.neg) break;                                          // 同目标正结果中断连续
    count++;
  }
  if (allowTerminate && count >= terminateAt) return { action: "terminate", count };
  if (count >= guideAt) return { action: "guide", count };
  return { action: "none", count };
}
/** 静态环境注入：toolstore 文件清单 + 记忆概览（失败容忍——不阻断任务） */
export async function buildEnvironmentPrelude(caps: Record<string, unknown>): Promise<string> {
  const parts: string[] = [];
  try {
    const fs = caps["fs"] as { list?(dir?: string): Promise<unknown> } | undefined;
    if (fs?.list) {
      const files = await fs.list();
      const text = JSON.stringify(files);
      if (text && text !== "[]") parts.push(`toolstore 文件: ${text.slice(0, 1000)}`);
    }
  } catch { /* 无 toolstore 容忍 */ }
  try {
    const memory = caps["memory"] as { query?(sql: string): Promise<unknown> } | undefined;
    if (memory?.query) {
      // 2026-08-15 修复：ASP 会话空间下 memory.query 强制要求 meta 列（可见性过滤依据）；
      // 聚合查询无法带行级 meta——改取 kind+meta 行后在 JS 聚合（LIMIT 由只读 SQL 层兜底）
      const rows = await memory.query("SELECT kind, meta FROM memory_entries LIMIT 200") as Array<{ kind?: string }>;
      const counts = new Map<string, number>();
      for (const r of rows) {
        if (typeof r.kind === "string") counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
      }
      const text = JSON.stringify([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([kind, n]) => ({ kind, n })));
      if (text && text !== "[]") parts.push(`记忆概览: ${text.slice(0, 1000)}`);
    }
  } catch { /* 记忆不可用容忍 */ }
  return parts.join("\n");
}

/** 内核（原 runAgentTask 循环体——压缩包装器包在外层） */
