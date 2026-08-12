/**
 * space-index —— asp.index 索引构造（ASP v2——2026-08-10）。
 *
 * 双聚合模式（用户裁决）：
 *   by-package —— 按扩展包/构造方式展开（每个包带了什么能力）
 *   by-type    —— 按类型展开（变量 / 对象 / 函数）
 *
 * 构造按目标空间语言骨架（协议："索引函数根据语言骨架的特征以及调用模式来构造"）：
 *   ts     —— vm context 枚举（包=注入能力对象；类型=snapshot 变量/函数）
 *   python —— kernel snapshot（globals 分区）
 *   bash   —— kernel snapshot
 *   c      —— 编译单元注册表（无变量概念——单元即函数）
 *   meta   —— 空间清单（子空间/骨架摘要）
 *
 * 输出纪律：每层 ≤ ~2KB（观测预算一半——单层永远可读完）；超出截断并标注。
 */

import type { WorkerKernel } from "../interpreter/index.js";
import { spaceRegistry } from "./space-registry.js";

const MAX_LAYER_CHARS = 1900;

export interface IndexCtx {
  currentSpace: string;
  kernel: WorkerKernel;
  caps: Record<string, unknown>;
}

function truncateLayer(s: string): string {
  if (s.length <= MAX_LAYER_CHARS) return s;
  return s.slice(0, MAX_LAYER_CHARS) + `…(截断——逐层深入：asp.index 指定更具体的子路径)`;
}

/** 对象 → 其函数/值键名清单（包内容速写） */
function keysOf(v: unknown, max = 12): string {
  if (v === null || typeof v !== "object") return typeof v;
  const keys = Object.keys(v as Record<string, unknown>).filter((k) => !k.startsWith("_"));
  const shown = keys.slice(0, max);
  return shown.join("/") + (keys.length > max ? `…(+${keys.length - max})` : "");
}

/** meta 空间索引：空间树（治理 v2——2026-08-12：索引即引导——展示子空间表单/深度/记忆域） */
function indexMeta(): string {
  const all = spaceRegistry.list();
  const roots = all.filter((s) => !s.parent || s.parent === "meta");
  const lines: string[] = [];
  for (const s of roots) {
    if (s.kind === "meta") {
      lines.push(`meta —— ${s.description}`);
      continue;
    }
    const gov: string[] = [];
    if (s.allowChildren) {
      gov.push(`可建子空间(maxDepth=${s.maxDepth ?? "∞"})`);
      const form = (s.childParams ?? []).map((p) => `${p.name}${p.required ? "*" : ""}`).join(" ");
      if (form) gov.push(`表单: ${form}`);
    }
    if (s.memoryScope) gov.push(`记忆域: ${s.memoryScope}`);
    lines.push(`${s.id}/ —— ${s.description}${gov.length ? `\n    [治理] ${gov.join("；")}` : ""}`);
    for (const child of spaceRegistry.childrenOf(s.id)) {
      lines.push(`  └─ ${child.id}/ —— ${child.description}${child.memoryScope ? `（记忆域: ${child.memoryScope}）` : ""}`);
    }
  }
  return truncateLayer(`【元空间】空间树（asp_cd 迁移进入；asp.create 在声明可建子空间的空间内创建——meta 禁建；done 仅本空间可用）：\n${lines.join("\n")}`);
}

/** ts 空间 by-package：扩展包 → 各包能力键 */
function indexTsByPackage(caps: Record<string, unknown>): string {
  const lines = Object.entries(caps)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => `${k}: ${keysOf(v)}`);
  return truncateLayer(`【ts 空间 · 按扩展包】\n${lines.join("\n")}\n（程序内 await 调用——如 await memory.query(...)）`);
}

/** snapshot → by-type 视图（变量/函数/超限） */
async function snapshotByType(snap: { variables: Array<{ key: string; serializable?: boolean }>; functions: Array<{ key: string }>; oversized: string[] }, spaceName: string): Promise<string> {
  const vars = snap.variables.filter((v) => !v.key.startsWith("_")).slice(0, 30).map((v) => v.key);
  const fns = snap.functions.filter((f) => !f.key.startsWith("_")).slice(0, 30).map((f) => f.key);
  return truncateLayer(
    `【${spaceName} 空间 · 按类型】\n变量(${vars.length}): ${vars.join(", ") || "（空）"}\n函数(${fns.length}): ${fns.join(", ") || "（空）"}` +
      (snap.oversized.length > 0 ? `\n超限对象: ${snap.oversized.join(", ")}` : ""),
  );
}

/** 构造空间索引（asp.index 入口） */
export async function buildSpaceIndex(opts: { mode?: string; space?: string }, ctx: IndexCtx): Promise<string> {
  const space = opts.space || ctx.currentSpace;   // 无参默认当前空间（用户裁决）
  const mode = opts.mode === "by-type" ? "by-type" : "by-package";

  if (space === "meta") return indexMeta();
  if (!spaceRegistry.isActionSpace(space)) {
    return `asp.index: 未知空间 "${space}"（已注册: ${spaceRegistry.list().map((s) => s.id).join("/")}）`;
  }

  if (space === "ts") {
    if (mode === "by-package") return indexTsByPackage(ctx.caps);
    const snap = await ctx.kernel.ts.snapshot();
    return snapshotByType(snap, "ts");
  }
  if (space === "python" || space === "bash") {
    const interp = space === "python" ? ctx.kernel.python : ctx.kernel.bash;
    const snap = await interp.snapshot();
    return snapshotByType(snap, space);   // 持久 REPL 无"包"概念——两模式同构（类型视图）
  }

  // 空间治理 v2（2026-08-12 批 3）：生产空间/自定义子空间——工具族视图（by-package 语义——族=包）
  const def = spaceRegistry.get(space);
  if (def?.execTool) {
    const families = [def.execTool, ...(def.extraTools ?? [])];
    const gov: string[] = [];
    if (def.allowChildren) {
      const form = (def.childParams ?? []).map((p) => `${p.name}${p.required ? "*" : ""}`).join(" ");
      gov.push(`可建子空间(maxDepth=${def.maxDepth ?? "∞"}${form ? `；表单: ${form}` : ""})`);
    }
    if (def.memoryScope) gov.push(`记忆域: ${def.memoryScope}`);
    const children = spaceRegistry.childrenOf(space);
    return truncateLayer(
      `【${space} 空间 · 工具族】\n${families.map((f) => `- ${f}.*`).join("\n")}${def.description ? `\n说明: ${def.description}` : ""}` +
        (gov.length ? `\n[治理] ${gov.join("；")}` : "") +
        (children.length ? `\n子空间: ${children.map((c) => c.id).join(", ")}` : ""),
    );
  }
  return `asp.index: 空间 "${space}" 暂无索引构造器`;
}
