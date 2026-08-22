/**
 * ptc/surface.ts —— 能力面越界预检（2026-08-14 A1 Phase 3 条目 9）。
 *
 * 目标：LLM 写的 ts 程序引用未注入能力（如 memeory.query / foo.bar）时，
 * 编译前结构化拒绝 + 引导消息（列出可用能力根）——替代运行时裸
 * "foo is not defined"（与 N12 unknown-tool 护栏同构：先引导后处置）。
 *
 * 保守策略（宁可漏报不可误伤——合法程序零误杀）：
 *   - 只检查「成员访问根」（root.x / root?.x / root[...]）与「直接调用根」（root(...)）两类位置；
 *   - 正则字面量/字符串/模板串/注释先剥离（其中内容不参与判定）；
 *   - 程序内声明（const/let/var/function/class/for/catch）、形参（function/箭头/方法）、
 *     解构名全部视为安全名（过度收集 = 漏报——安全方向）；
 *   - JS 内建全局白名单（node:vm createContext 实测 2026-08-14——vm 上下文无
 *     fetch/setTimeout/URL/structuredClone，越界引用本就是运行错误，预检只是把它变成引导消息）。
 * 已知边界（文档化）：
 *   - 模板串 ${} 插值表达式已纳入扫描（2026-08-15 审计修复）；插值内含反引号的
 *     嵌套模板串不覆盖（外层模板匹配边界）；
 *   - 无点无括号的裸引用（const y = foo）不在扫描面——运行时 ReferenceError 兜底；
 *   - `if (x) /re/` 这类「语句位正则」会按除法保留、不剥离（前邻 `)`）——正则内
 *     出现 root.x 形态时可能误报（极罕见——宁误报不漏报）。
 */

import { PTC_CAPABILITIES } from "./contract.js";

/** JS 内建全局（node:vm createContext 实测清单 2026-08-14——原型链 intrinsics，
 *  Object.keys(context) 枚举不到，需静态白名单） */
const JS_BUILTINS = new Set([
  "AggregateError", "Array", "ArrayBuffer", "AsyncDisposableStack", "Atomics", "BigInt",
  "BigInt64Array", "BigUint64Array", "Boolean", "DataView", "Date", "DisposableStack",
  "Error", "EvalError", "FinalizationRegistry", "Float16Array", "Float32Array", "Float64Array",
  "Function", "Infinity", "Int16Array", "Int32Array", "Int8Array", "Intl", "Iterator", "JSON",
  "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy", "RangeError", "ReferenceError",
  "Reflect", "RegExp", "Set", "SharedArrayBuffer", "String", "SuppressedError", "Symbol",
  "SyntaxError", "TypeError", "URIError", "Uint16Array", "Uint32Array", "Uint8Array",
  "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet", "WebAssembly", "console", "decodeURI",
  "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "eval", "globalThis",
  "isFinite", "isNaN", "parseFloat", "parseInt", "undefined", "unescape",
]);

/** JS 关键字/字面量（调用根扫描排除——if (/for ( 不是能力调用） */
const JS_KEYWORDS = new Set([
  "if", "for", "while", "do", "switch", "catch", "with", "return", "throw", "function",
  "typeof", "await", "void", "delete", "new", "instanceof", "yield", "in", "of", "else",
  "case", "default", "try", "finally", "async", "class", "const", "let", "var", "import",
  "export", "from", "as", "break", "continue", "this", "super", "null", "true", "false",
  "undefined", "NaN", "Infinity", "debugger",
]);

/** 模板串内容处理：普通文本掩码为空格，${...} 插值表达式原文保留（等长+表达式可见）——
 * 插值内能力引用参与越界判定（2026-08-15 审计 MEDIUM：此前整串剥离漏检）。 */
function stripTemplateContent(content: string): string {
  let out = "";
  let i = 0;
  while (i < content.length) {
    const ch = content[i]!;
    if (ch === "\\") { out += "  "; i += 2; continue; }
    if (ch === "$" && content[i + 1] === "{") {
      const end = findTemplateInterpEnd(content, i + 2);
      out += ` (${content.slice(i + 2, end)}) `;
      i = end + 1;
      continue;
    }
    out += " ";
    i++;
  }
  return out;
}

/** 找 ${...} 的匹配 }（嵌套对象/字符串感知——}` 在字符串内不算） */
function findTemplateInterpEnd(s: string, start: number): number {
  let depth = 0;
  for (let j = start; j < s.length; j++) {
    const ch = s[j]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      const q = ch;
      let k = j + 1;
      while (k < s.length) {
        if (s[k] === "\\") { k += 2; continue; }
        if (s[k] === q) { k++; break; }
        k++;
      }
      j = k;   // for 的 j++ 落到闭合引号之后
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      if (depth === 0) return j;
      depth--;
    }
  }
  return s.length;
}

/** 剥离正则字面量/字符串/模板串/注释——其中内容不参与越界判定 */
export function stripNonCode(code: string): string {
  let s = code;
  // 正则字面量（启发式：非标识符前缀的 / … / flags——防 // 注释剥离误伤正则内的 /）。
  // 用候选前的最后一个非空白字符区分「除号 vs 正则起点」（2026-08-15 筛查）：
  // 前邻是标识符/数字/) / ] → 除法，保留原样；前邻是 =( : , ; { [ ! & | ? + - * % < >
  // 或 return/case/throw/typeof/new/delete/void/instanceof/in/of/yield/await → 正则，剥离。
  // 含空白且上下文不像正则的候选同样保留（`a / b / c` 曾整段被剥成 /x/ 吞掉后续代码）。
  s = s.replace(/(^|[^\w$)\]])(\/(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[a-z]*)/g, (m, pre, lit, offset) => {
    const before = code.slice(0, offset + String(pre).length).replace(/\s+$/, "");
    const last = before.slice(-1);
    const prevWord = before.match(/([A-Za-z_$][\w$]*)$/)?.[1] ?? "";
    const regexStartCtx = /^[=(:;,{[!&|?+\-*%<>]$/.test(last)
      || ["return", "case", "throw", "typeof", "new", "delete", "void", "instanceof", "in", "of", "yield", "await"].includes(prevWord);
    if (regexStartCtx) return pre + "/x/";
    return m;   // 除法上下文——不剥（宁可漏报，不可误伤）
  });
  // 模板串先于字符串处理：文本掩码、${...} 插值表达式保留（插值内引用可检——2026-08-15 审计 MEDIUM；
  // 若先剥字符串，模板文本中的引号会被误当 JS 字符串剥掉整段插值）
  s = s.replace(/\`(?:\\[\s\S]|[^\`\\])*\`/g, (tpl) => ` ${stripTemplateContent(tpl.slice(1, -1))} `);
  // 字符串（单/双引号——含转义；插值表达式内的字符串在这里剥离）
  s = s.replace(/'(\\.|[^'\\\n])*'|"(\\.|[^"\\\n])*"/g, '""');
  // 注释
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ");
  s = s.replace(/\/\/[^\n]*/g, " ");
  return s;
}

/** 收集安全名：声明/形参/解构/方法名——过度收集（漏报）是安全方向 */
function collectSafeNames(stripped: string, out: Set<string>): void {
  const idRe = /[A-Za-z_$][\w$]*/g;
  const addIdentifiers = (snippet: string) => {
    for (const m of snippet.matchAll(idRe)) out.add(m[0]!);
  };
  const skipWs = (i: number): number => {
    while (i < stripped.length && /\s/.test(stripped[i]!)) i++;
    return i;
  };
  const skipBalanced = (i: number, open: string, close: string): number => {
    let depth = 0;
    for (; i < stripped.length; i++) {
      const c = stripped[i]!;
      if (c === open) depth++;
      else if (c === close && --depth === 0) return i + 1;
    }
    return stripped.length;
  };
  /** 跳过初始化表达式到顶层 , ; ) }（括号/方括号/花括号深度感知——箭头/对象/调用不误断） */
  const skipExpression = (i: number): number => {
    let p = 0, b = 0, c = 0;
    for (; i < stripped.length; i++) {
      const ch = stripped[i]!;
      if (ch === "(") p++;
      else if (ch === ")" && p > 0) p--;
      else if (ch === "[") b++;
      else if (ch === "]" && b > 0) b--;
      else if (ch === "{") c++;
      else if (ch === "}" && c > 0) c--;
      else if ((ch === "," || ch === ";" || ch === ")" || ch === "}") && p === 0 && b === 0 && c === 0) return i;
    }
    return stripped.length;
  };
  /** 解构模式名收集（2026-08-15 审计修复：默认值 RHS 不再误收为安全名）：
   *  绑定名/别名/嵌套绑定全部入 safe；`=` 后的默认值表达式整体跳过（留给越界扫描——
   *  { a = foo.bar } 的 foo 必须可检）；箭头/函数形参由全局形参正则另行收集。 */
  const addPattern = (pattern: string): void => {
    let i = 0;
    const skipWsIn = (pos: number): number => {
      while (pos < pattern.length && /\s/.test(pattern[pos]!)) pos++;
      return pos;
    };
    /** 跳过默认值表达式到顶层 , ; ) }（括号/方括号/花括号深度感知——对象默认值/箭头不误断） */
    const skipExprIn = (pos: number): number => {
      let p = 0, b = 0, c = 0;
      for (let j = pos; j < pattern.length; j++) {
        const ch = pattern[j]!;
        if (ch === "(") p++;
        else if (ch === ")" && p > 0) p--;
        else if (ch === "[") b++;
        else if (ch === "]" && b > 0) b--;
        else if (ch === "{") c++;
        else if (ch === "}" && c > 0) c--;
        else if ((ch === "," || ch === ";" || ch === ")" || ch === "}") && p === 0 && b === 0 && c === 0) return j;
      }
      return pattern.length;
    };
    const parse = (): void => {
      while (i < pattern.length) {
        i = skipWsIn(i);
        if (i >= pattern.length) return;
        const ch = pattern[i]!;
        if (ch === "{" || ch === "[") { i++; parse(); continue; }   // 嵌套模式
        if (ch === "}" || ch === "]") { i++; return; }              // 当前模式收口
        if (ch === "." && pattern[i + 1] === "." && pattern[i + 2] === ".") { i += 3; continue; }   // rest
        if (/[A-Za-z_$]/.test(ch)) {
          const m = /[A-Za-z_$][\w$]*/.exec(pattern.slice(i));
          if (!m) { i++; continue; }
          out.add(m[0]!);
          i += m[0].length;
        } else {
          i++;
          continue;
        }
        i = skipWsIn(i);
        if (pattern[i] === ":") { i = skipWsIn(i + 1); continue; }               // 别名/嵌套绑定
        if (pattern[i] === "=") { i = skipWsIn(skipExprIn(i + 1)); continue; }   // 默认值——不收集 RHS
        if (pattern[i] === ",") { i++; continue; }
        return;
      }
    };
    parse();
  };
  /** 声明词后逐项解析声明符（含逗号连声明 + 解构 + 初始化——2026-08-15 筛查修复） */
  const collectDeclarationNames = (start: number): void => {
    let i = skipWs(start);
    while (i < stripped.length) {
      const ch = stripped[i]!;
      if (ch === "{" || ch === "[") {
        const end = skipBalanced(i, ch, ch === "{" ? "}" : "]");
        addPattern(stripped.slice(i + 1, end - 1));   // 绑定名入 safe；默认值 RHS 留给扫描
        i = end;
      } else if (/[A-Za-z_$]/.test(ch)) {
        const m = /[A-Za-z_$][\w$]*/.exec(stripped.slice(i));
        if (!m) return;
        out.add(m[0]!);
        i += m[0].length;
      } else {
        return;
      }
      i = skipWs(i);
      if (stripped[i] === "=") i = skipWs(skipExpression(i + 1));
      if (stripped[i] === ",") {
        i = skipWs(i + 1);
        continue;
      }
      return;
    }
  };
  for (const m of stripped.matchAll(/\b(?:const|let|var)\b/g)) collectDeclarationNames(m.index + m[0].length);
  for (const m of stripped.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]!);
  // 生成器函数名（function* f——2026-08-15 筛查修复）
  for (const m of stripped.matchAll(/\bfunction\s*\*\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]!);
  for (const m of stripped.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]!);
  // catch 参数（含解构）——整体过收为安全方向
  for (const m of stripped.matchAll(/\bcatch\s*\(([^()]*)\)/g)) addIdentifiers(m[1]!);
  // 形参：function f(a, b) / 箭头 (a, b) => / 单参箭头 x =>
  for (const m of stripped.matchAll(/\bfunction\s*(?:[A-Za-z_$][\w$]*)?\s*\(([^()]*)\)/g)) addIdentifiers(m[1]!);
  for (const m of stripped.matchAll(/\(([^()]*)\)\s*=>/g)) addIdentifiers(m[1]!);
  for (const m of stripped.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*=>/g)) out.add(m[1]!);
  // 方法简写/访问器/类方法名（name(params){ —— 2026-08-15 筛查修复）：
  // 前置不能是 ( . ?（调用位）——if (foo()) {} 的 foo 仍走越界判定；{ rb(x){ } } 的 rb 记安全。
  // 控制流关键字整条跳过——if/while/switch/for 头部不是方法头（2026-08-15 审计 M1）。
  for (const m of stripped.matchAll(/(?<![\w$.(?])([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g)) {
    if (JS_KEYWORDS.has(m[1]!)) continue;
    out.add(m[1]!);
    addIdentifiers(m[2]!);
  }
}

/** 扫描成员访问根 + 直接调用根 → 越界根列表（knownGlobals = 注入面键集合） */
export function findOutOfBoundsRoots(code: string, knownGlobals: ReadonlySet<string>): string[] {
  const stripped0 = stripNonCode(code);
  // TS 非空断言归一化（foo!.bar / foo!() 与执行面 stripTypeScriptTypes 对齐——2026-08-15 审计 M4）
  const stripped = stripped0.replace(/!\./g, ".").replace(/!\(/g, "(");
  const safe = new Set<string>();
  collectSafeNames(stripped, safe);
  const out = new Set<string>();
  const consider = (root: string) => {
    if (knownGlobals.has(root) || safe.has(root) || JS_BUILTINS.has(root) || JS_KEYWORDS.has(root)) return;
    out.add(root);
  };
  // 成员访问根：root.x / root?.x / root[...]（负向后行断言排除属主前的 . / ?. / ) / ]。
  // 不再消费前导字符——否则 if (foo()) 中 if( 会吃掉 ( 使 foo( 失去前导上下文而漏检）
  for (const m of stripped.matchAll(/(?<![\w$)\].?])([A-Za-z_$][\w$]*)\s*(?:\??\.|\[)/g)) consider(m[1]!);
  // 直接调用根：root( ——排除方法调用（前导 .）与调用结果（前导 )）
  for (const m of stripped.matchAll(/(?<![\w$).])([A-Za-z_$][\w$]*)\s*\??\(/g)) consider(m[1]!);
  // TS as 断言根（foo as Bar / await foo() as T——2026-08-15 审计：此前只扫成员/调用漏检）
  for (const m of stripped.matchAll(/(?<![\w$).])([A-Za-z_$][\w$]*)\s+as\b/g)) consider(m[1]!);
  return [...out];
}

/** 注册表派生的能力根清单（引导消息用） */
export function capabilityRoots(): string[] {
  return [...new Set(Object.keys(PTC_CAPABILITIES).map((n) => n.split(".")[0]!))];
}

/** 越界引导消息（编译前拒绝——列出可用能力根） */
export function buildSurfaceGuidance(roots: string[]): string {
  const uniq = [...new Set(roots)];
  return `[契约] ts 程序引用了未注入的能力 ${uniq.map((r) => '"' + r + '"').join("、")}——能力面越界（编译前拒绝，未执行）。可用能力根：${capabilityRoots().join(" / ")}。完整签名与用法见 capability-index（memory.query 查 kind='capability-index'）；若为拼写错误请修正后重试。`;
}
