import { createContext, runInContext, type Context } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import type { ExecuteOptions, Interpreter, InterpreterResult, InterpreterSnapshot } from "./types.js";

export const DEFAULT_EXECUTION_TIMEOUT_MS = 300_000;

/**
 * TS 解释器：node:vm 持久 context + stripTypeScriptTypes。
 * 能力注入：context 默认空，只注入白名单（构造时传入 capabilities）。
 * 前置校验（对抗性审核 B5）：import/require 拒绝 + top-level await 包装。
 *
 * 设计级限制（Finding #3，不修代码、固化行为）：context 跨 execute 持久，全局词法绑定
 * （let/const/class 声明）无法在后续 execute 中重声明——重复 `const s = ...` 抛
 * "Identifier 's' has already been declared"。需要重新声明应调用 reset() 重建 context
 * （capabilities 保留）或新建 interpreter。
 */
export class TsInterpreter implements Interpreter {
  readonly language = "ts";
  private context: Context;
  private capabilities: Record<string, unknown>;

  constructor(deps: { capabilities: Record<string, unknown>; timeoutMs?: number }) {
    this.capabilities = deps.capabilities;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.context = createContext({ ...deps.capabilities });
  }

  private timeoutMs: number;
  get state(): Record<string, unknown> {
    return this.context as unknown as Record<string, unknown>;
  }

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const start = Date.now();
    try {
      const pre = preflight(program);
      if (!pre.ok) {
        return { ok: false, error: { message: pre.error }, durationMs: Date.now() - start };
      }
      const js = stripTypeScriptTypes(pre.code);
      const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
      // Finding #1（Critical 修复）：runInContext 的 timeout 只覆盖同步执行——await 后的异步延续
      // 不受限，`await new Promise(()=>{})` 永不 resolve 会无限挂起 execute（kernel 线程阻塞 =
      // 单点 DoS）。异步守卫：Promise.race([执行, 超时 reject])，超时语义与同步 timeout 一致
      // （opts.timeoutMs ?? this.timeoutMs）。
      const context = this.context;
      const runPromise = (async () => {
        const result = runInContext(js, context, { timeout: timeoutMs });
        return { ok: true, value: await normalize(result), durationMs: Date.now() - start };
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const guardPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`script execution timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      try {
        return await Promise.race([runPromise, guardPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (e) {
      const err = e as Error;
      return { ok: false, error: { message: err.message, stack: err.stack }, durationMs: Date.now() - start };
    }
  }

  snapshot() {
    // 枚举 context 全局（var/function 可见；const/let 词法绑定不可见）
    const RESERVED = new Set(["llm", "memory", "web", "tasks", "skills", "bash", "python", "state"]);
    const snap: InterpreterSnapshot = { variables: [], functions: [], oversized: [] };
    for (const key of Object.keys(this.context)) {
      if (RESERVED.has(key)) continue;
      const v = (this.context as Record<string, unknown>)[key];
      if (typeof v === "function") {
        snap.functions.push({ key, source: v.toString() });
        continue;
      }
      try {
        JSON.stringify(v);
        snap.variables.push({ key, value: v, serializable: true });
      } catch {
        snap.oversized.push(key);
      }
    }
    return snap;
  }

  reset(): void {
    this.context = createContext({ ...this.capabilities });
  }

  dispose(): void {
    // vm context 无显式释放；GC 处理
  }
}

/** 前置校验：import/require 拒绝 + top-level await 包装（异步 IIFE） */
function preflight(program: string): { ok: true; code: string } | { ok: false; error: string } {
  // import 语句（行首 import 或 import( 动态导入）
  if (/^\s*import\s/m.test(program) || /import\s*\(/.test(program)) {
    return { ok: false, error: "import is not allowed in kernel programs — use injected globals (llm/memory/skills/tasks/bash/python)" };
  }
  // require 调用
  if (/\brequire\s*\(/.test(program)) {
    return { ok: false, error: "require is not allowed in kernel programs — use injected globals (llm/memory/skills/tasks/bash/python)" };
  }
  // 统一包装为异步 IIFE：await（异步延续）与顶层 return 都需要函数上下文。
  // （试运行发现：无 await 但有 return 的任务代码不被包装 → "Return statement is not allowed"）
  if (/\bawait\b/.test(program) || /^\s*return\b/m.test(program) || /\breturn\s*\{/.test(program)) {
    return { ok: true, code: wrapAwait(program) };
  }
  return { ok: true, code: program };
}

/**
 * top-level await 包装。适配说明（brief 实现缺陷修复）：brief 的块包装
 * `(async () => { ${program} })()` 对表达式程序（如 `await Promise.resolve(42)`）
 * 不捕获 completion value，IIFE resolve 为 undefined（测试要求 42）。
 * 修复：单表达式程序用 return 包装（捕获值）；语句式程序保持块包装
 * （语句完整执行）。若一律 return 包装，`const r = await f(); r` 会语法错误、
 * `await g(); await h()` 会静默只执行第一条——故需启发式区分。
 */
function wrapAwait(program: string): string {
  // Finding #2（修复）：尾分号剥离。`await Promise.resolve(42);` 的末尾 `;` 会被误判为
  // 多语句分隔符 → 块包装 → completion value 丢失（测试要求 42）。先剥离末尾空白/分号再判别；
  // 内部 `;`（真多语句）保留，仍走块包装。
  const trimmed = program.replace(/[;\s]+$/, "").trim();
  // 声明/控制流关键字开头的程序是语句式（块包装保语义）
  const startsWithStatementKeyword = /^(?:let\b|const\b|var\b|function\b|class\b|if\b|for\b|while\b|do\b|switch\b|try\b|catch\b|finally\b|return\b|throw\b|import\b|export\b|debugger\b|with\b|\{|;)/.test(trimmed);
  // 含顶层 ; 或换行 => 多语句（块包装保语句完整）；单行模板串内换行属已知边界（不捕获值，仅值丢失不影响执行）
  const hasTopLevelSeparator = /[\n;]/.test(trimmed);
  if (!startsWithStatementKeyword && !hasTopLevelSeparator) {
    return `(async () => { return ${program} })()`;
  }
  // 块包装 + 自动导出（T4 refine 支持）：顶层 function/var 声明转发到 globalThis
  // （否则 IIFE 局部声明 snapshot 不可见——试运行发现 fibonacci 提炼为空）。
  // 关键：导出必须插在 return 之前（return 后的代码是死代码）。
  const autoExport = extractTopLevelDecls(program)
    .map((name) => `globalThis.${name} = ${name};`)
    .join("\n");
  const withExport = insertBeforeReturn(program, autoExport);
  return `(async () => { ${withExport} })()`;
}

/**
 * 提取顶层声明名（refine 自动导出用）：
 *   function NAME(...)  /  var NAME = ...  → [NAME]
 * const/let 不导出（词法绑定，globalThis 转发会抛 TDZ 错误——与 vm 语义一致）。
 * 正则启发式（非完整 AST）：覆盖常见任务代码形态。
 */
function extractTopLevelDecls(program: string): string[] {
  const names = new Set<string>();
  const fnRe = /^\s*function\s+([A-Za-z_$][\w$]*)/gm;
  const varRe = /^\s*var\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of program.matchAll(fnRe)) names.add(m[1]!);
  for (const m of program.matchAll(varRe)) names.add(m[1]!);
  return [...names];
}

/**
 * 把导出语句插到最后一个顶层 return 之前（return 后是死代码）。
 * 无 return → 直接追加尾部。
 */
function insertBeforeReturn(program: string, insertion: string): string {
  const lines = program.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*return\b/.test(lines[i]!)) {
      lines.splice(i, 0, insertion);
      return lines.join("\n");
    }
  }
  return program + "\n" + insertion;
}

/**
 * 求值结果规范化：undefined → undefined；对象/数组 JSON 序列化友好。
 * 适配说明（brief 实现缺陷修复）：runInContext 对 async IIFE / async 能力函数
 * 返回裸 Promise，不 await 则 value 是 Promise 对象——故对 thenable 做解析。
 */
async function normalize(value: unknown): Promise<unknown> {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value.toString();
  if (value !== null && typeof (value as { then?: unknown }).then === "function") {
    return await (value as Promise<unknown>);
  }
  return value;
}
