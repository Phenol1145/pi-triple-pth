/**
 * resolver-core.ts — TaskResolver 核心纯函数（T1：路由声明与匹配）
 *
 * 任务 = 自带路由的数据包（payload.flow.stages 有序阶段表）。
 * 本文件：match 规则匹配 / flow 校验 / 待解析判定——无副作用，可测。
 */

import type { Task } from "@away_from/pth-kernel-storage";

// ── 类型 ─────────────────────────────────────────────────

export type MatchRule = Record<string, unknown>;

export interface TransformSpec {
  kind?: string;
  role?: string;
  status?: string;
  reason?: string;
}

export interface DecomposeSpec {
  kind?: string;
  role?: string;
  title: string;
  text: string;
  tags?: string[];
  flow?: FlowSpec;
}

export interface BranchCase {
  if?: string;
  transform?: TransformSpec;
  decompose?: DecomposeSpec[];
}

export interface LoopSpec {
  until: string;
  max?: number;
}

export interface Stage {
  id: string;
  match?: MatchRule;
  transform?: TransformSpec;
  decompose?: DecomposeSpec[];
  branch?: BranchCase[];
  loop?: LoopSpec;
  terminal?: boolean;
  wait?: boolean;   // match 不满足时：true=等待（不跳过），false/缺省=跳过注销
}

export interface FlowSpec {
  version?: number;
  stages: Stage[];
}

const KNOWN_STAGE_KEYS = new Set(["id", "match", "transform", "decompose", "branch", "loop", "terminal", "wait"]);

// ── 匹配（§4.1：JSON 匹配，零依赖）───────────────────────

function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * JSON 匹配：rule 的每个字段精确等于 task 对应字段（点路径支持嵌套）。
 * 值 "*" 通配任意；缺省字段不参与。空 rule = 恒真。
 */
export function matchesRule(rule: MatchRule, task: Pick<Task, "status" | "payload">): boolean {
  for (const [key, expected] of Object.entries(rule)) {
    const actual = key.includes(".") ? resolvePath(task.payload, key) : key === "status" ? task.status : resolvePath(task.payload, key);
    if (expected === "*") continue;
    if (actual !== expected) return false;
  }
  return true;
}

// ── flow 校验（§3.2）──────────────────────────────────────

export function validateFlow(flow: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof flow !== "object" || flow === null) return { ok: false, error: "flow must be an object" };
  const f = flow as FlowSpec;
  if (!Array.isArray(f.stages) || f.stages.length === 0) return { ok: false, error: "flow.stages must be a non-empty array" };
  for (const stage of f.stages) {
    if (typeof stage !== "object" || stage === null) return { ok: false, error: "stage must be an object" };
    if (typeof stage.id !== "string" || !stage.id) return { ok: false, error: "stage.id required" };
    for (const key of Object.keys(stage)) {
      if (!KNOWN_STAGE_KEYS.has(key)) return { ok: false, error: `unknown stage field: ${key}` };
    }
    if (stage.match !== undefined) {
      for (const [k, v] of Object.entries(stage.match)) {
        if (typeof v !== "string" && typeof v !== "boolean" && typeof v !== "number" && v !== null) {
          return { ok: false, error: `match field ${k} must be primitive (string/boolean/number/null)` };
        }
      }
    }
    if (stage.decompose !== undefined) {
      for (const d of stage.decompose) {
        if (typeof d.title !== "string" || typeof d.text !== "string") {
          return { ok: false, error: `decompose item requires title/text strings` };
        }
      }
    }
    if (stage.loop !== undefined) {
      if (typeof stage.loop.until !== "string") return { ok: false, error: "loop.until required" };
    }
  }
  return { ok: true };
}

// ── 待解析判定（§5.1 SQL 的 JS 等价）──────────────────────

/** 有 flow 且存在未注销阶段 → 需要解析 */
export function isResolvable(task: Pick<Task, "payload">): boolean {
  const p = (task.payload ?? {}) as { flow?: FlowSpec; resolvedStages?: string[] };
  if (!p.flow || !Array.isArray(p.flow.stages)) return false;
  const resolved = p.resolvedStages ?? [];
  return p.flow.stages.length > resolved.length;
}

// ── 条件表达式（§4.2：白名单递归下降解析器，零依赖不 eval）──────

/**
 * 表达式语法（支持嵌套）：
 *   expr    := or
 *   or      := and ( "||" and )*
 *   and     := not ( "&&" not )*
 *   not     := "!" not | primary
 *   primary := "(" expr ")" | cmp
 *   cmp     := path op literal
 *   op      := "==" | "!=" | "<" | ">" | "<=" | ">="
 * 求值失败（语法错误/未知路径）→ false（不抛——解析器容错）。
 */

type Token = { type: "ident" | "str" | "num" | "op" | "punct"; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if (c === "(" || c === ")") { tokens.push({ type: "punct", value: c }); i++; continue; }
    if (c === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) return [];
      tokens.push({ type: "str", value: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
      if (!m) return [];
      tokens.push({ type: "num", value: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_.]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
      if (!m) return [];
      tokens.push({ type: "ident", value: m[0] });
      i += m[0].length;
      continue;
    }
    const op = ["==", "!=", "<=", ">=", "&&", "||", "!", "<", ">"].find((o) => src.startsWith(o, i));
    if (op) { tokens.push({ type: "op", value: op }); i += op.length; continue; }
    return [];  // 未知字符
  }
  return tokens;
}

class ExprParser {
  private pos = 0;
  private ctx: Record<string, unknown>;
  constructor(private tokens: Token[], ctx: Record<string, unknown>) {
    this.ctx = ctx;
  }

  parse(): boolean {
    try {
      const v = this.parseOr();
      return this.pos === this.tokens.length ? v : false;
    } catch {
      return false;
    }
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token | undefined { return this.tokens[this.pos++]; }

  private parseOr(): boolean {
    let v = this.parseAnd();
    while (this.peek()?.type === "op" && this.peek()!.value === "||") {
      this.next();
      const r = this.parseAnd();
      v = v || r;
    }
    return v;
  }

  private parseAnd(): boolean {
    let v = this.parseNot();
    while (this.peek()?.type === "op" && this.peek()!.value === "&&") {
      this.next();
      const r = this.parseNot();
      v = v && r;
    }
    return v;
  }

  private parseNot(): boolean {
    if (this.peek()?.type === "op" && this.peek()!.value === "!") {
      this.next();
      return !this.parseNot();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): boolean {
    const t = this.peek();
    if (t?.type === "punct" && t.value === "(") {
      this.next();
      const v = this.parseOr();
      if (this.peek()?.value !== ")") throw new Error("expected )");
      this.next();
      return v;
    }
    return this.parseCmp();
  }

  private parseCmp(): boolean {
    const lhs = this.next();
    const op = this.next();
    const rhs = this.next();
    if (!lhs || !op || !rhs) throw new Error("incomplete comparison");
    if (op.type !== "op" || !["==", "!=", "<", ">", "<=", ">="].includes(op.value)) throw new Error("bad op");
    return compare(lhs.value, rhs, op.value, this.ctx);
  }

}

function compare(path: string, rhs: Token, op: string, ctx: Record<string, unknown>): boolean {
  const actual = resolvePath(ctx, path);
  // rhs：str → 字符串；num → 数字；ident 的 true/false/null → 字面量；其他 ident → ctx 路径
  let expected: unknown;
  if (rhs.type === "str") expected = rhs.value;
  else if (rhs.type === "num") expected = Number(rhs.value);
  else if (rhs.value === "true") expected = true;
  else if (rhs.value === "false") expected = false;
  else if (rhs.value === "null") expected = null;
  else expected = resolvePath(ctx, rhs.value);
  switch (op) {
    case "==": return actual == expected;
    case "!=": return actual != expected;
    case "<": return (actual as number) < (expected as number);
    case ">": return (actual as number) > (expected as number);
    case "<=": return (actual as number) <= (expected as number);
    case ">=": return (actual as number) >= (expected as number);
    default: return false;
  }
}

/** 求值条件表达式（容错：非法 → false） */
export function evalCondition(expr: string, ctx: Record<string, unknown>): boolean {
  const tokens = tokenize(expr);
  if (tokens.length === 0) return false;
  return new ExprParser(tokens, ctx).parse();
}
