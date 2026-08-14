import { createContext, runInContext, type Context } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import type { ExecuteOptions, Interpreter, InterpreterResult, InterpreterSnapshot } from "../../kernel/interpreter/types.js";
import { buildSeeds } from "../../kernel/extensions/index.js";

export const DEFAULT_EXECUTION_TIMEOUT_MS = 300_000;

/**
 * TS 解释器：node:vm 持久 context + stripTypeScriptTypes。
 * 能力注入：context 默认空，只注入白名单（构造时传入 capabilities）。
 * 前置校验（对抗性审核 B5）：import/require 拒绝 + top-level await 包装。
 * Seam（2026-08-14 A1 Phase 2）：本核只管「程序 × 绑定」——构造入参即 bindings，
 * 能力从哪装配由上层（ptc/runner + buildCapabilities）拥有（对照 DSH：Runtimes know nothing about tools）。
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
  private seeds: Record<string, unknown>;
  /** 当前执行 cwd（每次 execute 更新——fs.task 任务工作区动态定位） */
  currentCwd: string | null = null;

  constructor(deps: { capabilities: Record<string, unknown>; timeoutMs?: number }) {
    this.capabilities = deps.capabilities;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    // 标准扩展包预置对象（results/context/model——ts 核内 agent 状态，内部管理语言语义）
    // seeds 保存（reset 重建 context 用——生产暴露：reset 丢 seeds → context/results 未定义）
    this.seeds = buildSeeds();
    this.context = createContext({
      ...this.seeds,
      ...deps.capabilities,
    });
  }

  private timeoutMs: number;
  get state(): Record<string, unknown> {
    return this.context as unknown as Record<string, unknown>;
  }

  /** 动态注入能力（兼容性扩展——ext.kernel 后注册的新执行核进 vm context） */
  injectCapability(name: string, value: unknown): void {
    (this.context as Record<string, unknown>)[name] = value;
  }

  /** 结果注册（agent-loop 工具执行后调用）：写入 ts 核内 results 对象 */
  registerResult(key: string, value: unknown): void {    const results = (this.context as Record<string, unknown>)["results"] as Record<string, unknown>;
    if (results && typeof results === "object") results[key] = value;
  }

  /** 读 ts 核内对象（agent-loop 需要时——如任务尾沉淀） */
  readObject(name: "results" | "context"): Record<string, unknown> {
    const v = (this.context as Record<string, unknown>)[name];
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  }

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const start = Date.now();
    try {
      const pre = preflight(program, opts?.exec ?? "auto");
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
      this.currentCwd = opts?.cwd ?? null;   // fs.task 任务工作区定位（每任务）
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
    const RESERVED = new Set(["llm", "memory", "web", "tasks", "skills", "bash", "python", "state", "results", "context", "sql"]);
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
    // 重建 context 保留 seeds（context/results/model 预置）——修复：reset 丢 seeds bug
    this.context = createContext({
      ...this.seeds,
      ...this.capabilities,
    });
  }

  dispose(): void {
    // vm context 无显式释放；GC 处理
  }
}

/** 前置校验：import/require 拒绝 + 执行模式包装（异步 IIFE）。
 * 模式（2026-08-11 元命令拆分——显式声明而非启发式猜测）：
 *   single  → return 包装：completion value 必回（单表达式求值）；
 *   program → 块包装：完整程序执行（声明/多语句/控制流——尾表达式捕获）；
 *   auto    → 旧启发式判别（存量调用兼容）。 */
function preflight(program: string, exec: "single" | "program" | "auto"): { ok: true; code: string } | { ok: false; error: string } {
  // import 语句（行首 import 或 import( 动态导入）
  if (/^\s*import\s/m.test(program) || /import\s*\(/.test(program)) {
    return { ok: false, error: "import is not allowed in kernel programs — use injected globals (llm/memory/skills/tasks/bash/python)" };
  }
  // require 调用
  if (/\brequire\s*\(/.test(program)) {
    return { ok: false, error: "require is not allowed in kernel programs — use injected globals (llm/memory/skills/tasks/bash/python)" };
  }
  const mode = exec === "auto"
    // 旧启发式：含 await/return → 包装；否则裸执行
    ? (() => (/(\bawait\b)|(^\s*return\b)|(return\s*\{)/m.test(program) ? "wrap" : "bare"))()
    : (exec === "single" ? "single" : "program");
  if (mode === "bare") return { ok: true, code: program };
  return { ok: true, code: wrapAwait(program, mode) };
}

/**
 * top-level await 包装（异步 IIFE）。适配说明（brief 实现缺陷修复）：brief 的块包装
 * `(async () => { ${program} })()` 对表达式程序（如 `await Promise.resolve(42)`）
 * 不捕获 completion value，IIFE resolve 为 undefined（测试要求 42）。
 * 修复：单表达式程序用 return 包装（捕获值）；语句式程序保持块包装
 * （语句完整执行）。若一律 return 包装，`const r = await f(); r` 会语法错误、
 * `await g(); await h()` 会静默只执行第一条——故需启发式区分。
 * 2026-08-11 元命令拆分：single（显式单表达式）/ program（显式程序）/ wrap（auto 启发式）。
 */
function wrapAwait(program: string, mode: "single" | "program" | "wrap"): string {
  if (mode === "single") {
    // 显式单表达式：return 包装——completion value 必回（尾分号在 return 语句内合法）
    return `(async () => { return ${program} })()`;
  }
  if (mode === "program") {
    // 显式程序：块包装完整执行（声明/多语句/控制流——尾表达式捕获）
    return blockWrap(program);
  }
  // auto 启发式（旧行为）
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
  return blockWrap(program);
}

/** 块包装：autoExport + 尾表达式捕获（program 模式与 auto 多语句共用） */
function blockWrap(program: string): string {
  const trimmed = program.replace(/[;\s]+$/, "").trim();
  // 块包装 + 自动导出（T4 refine 支持）：顶层 function/var 声明转发到 globalThis
  // （否则 IIFE 局部声明 snapshot 不可见——试运行发现 fibonacci 提炼为空）。
  // try-catch 包裹：正则误判的嵌套声明（如函数内 `; var x`）导出失败静默跳过，不破坏任务。
  const autoExport = extractTopLevelDecls(program)
    .map((name) => `try { globalThis.${name} = ${name}; } catch {}`)
    .join("\n");
  const withExport = insertBeforeReturn(program, autoExport);
  // 尾表达式捕获（2026-08-09 端到端暴露：多语句程序 completion value 丢失——report; 尾表达式
  // 块包装不返回 → submit ref 无 value。追加 `return (尾表达式)` 安全捕获；无尾表达式/无法判定 → 不加）
  const tailReturn = extractTailExpression(trimmed);
  return `(async () => { ${withExport}${tailReturn ? `\nreturn (${tailReturn});` : ""} })()`;
}

/**
 * 尾表达式提取（块包装 completion value 捕获——安全判定）：
 * 取最后顶层分隔（\n/;）后的片段；声明/控制流/块/注释开头或含块尾 → 非表达式（不追加）。
 * 粗粒度（split 分隔）——多语句程序惯例每行一句；字符串/注释内含分隔符的边缘场景最后段不受影响。
 */
function extractTailExpression(program: string): string | null {
  const parts = program
    .split(/[\n;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  // 排除声明/控制流/块/注释（这些不是表达式——追加 return 会语法错误）
  if (/^(let|const|var|function|class|if|for|while|do|switch|try|catch|finally|return|throw|import|export|debugger|with|\{|\}|\/\/|\/\*)/.test(last)) return null;
  if (/[{}]$/.test(last)) return null;
  return last;
}

/**
 * 提取顶层声明名（refine 自动导出用）：
 *   function NAME(...)  /  var NAME = ...  → [NAME]
 * 仅匹配【行首】顶层声明——模板包装（如 dev-task-ts 的 __fn 函数体）内的声明不导出
 * （由模板自身的 autoExportBlock 处理，避免作用域错误）。
 */
function extractTopLevelDecls(program: string): string[] {
  const names = new Set<string>();
  // 行首模式（模板渲染任务多行结构）
  const fnRe = /^function\s+([A-Za-z_$][\w$]*)/gm;
  const varRe = /^var\s+([A-Za-z_$][\w$]*)/gm;
  // 单行模式（压缩/单行任务代码）：声明前是行首/分号/大括号结束——函数内 `{ var` 不匹配（嵌套安全），
  // 命名函数表达式 `: function f` 不匹配（前缀是冒号），for 循环 `(var` 不匹配
  const fnOneLine = /(?:^|[;}])\s*function\s+([A-Za-z_$][\w$]*)/g;
  const varOneLine = /(?:^|[;}])\s*var\s+([A-Za-z_$][\w$]*)/g;
  for (const m of program.matchAll(fnRe)) names.add(m[1]!);
  for (const m of program.matchAll(varRe)) names.add(m[1]!);
  for (const m of program.matchAll(fnOneLine)) names.add(m[1]!);
  for (const m of program.matchAll(varOneLine)) names.add(m[1]!);
  return [...names];
}

/**
 * 把导出语句插到最后一个顶层 return 之前（return 后是死代码）。
 * 无 return → 直接追加尾部。
 */
/**
 * 把导出语句插到最后一个顶层 return 之前（return 后是死代码）。
 * 优先行首 return（模板渲染任务多行结构）；单行任务代码（return 不在行首）
 * fallback 到任意位置最后一个 return（\b 词法边界，防误匹配 returnX/嵌套 return）
 * ——否则导出语句被追加到 return 后成死代码，snapshot 永远为空（perf 摸底发现）。
 */
function insertBeforeReturn(program: string, insertion: string): string {
  const lines = program.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*return\b/.test(lines[i]!)) {
      lines.splice(i, 0, insertion);
      return lines.join("\n");
    }
  }
  // fallback：任意位置最后一个 return（词法边界）——单行/压缩代码
  let lastIdx = -1;
  for (const m of program.matchAll(/(?:^|[^A-Za-z0-9_$])return\b/g)) {
    lastIdx = m.index! + m[0].lastIndexOf("return");
  }
  if (lastIdx >= 0) {
    return program.slice(0, lastIdx) + insertion + "\n" + program.slice(lastIdx);
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
