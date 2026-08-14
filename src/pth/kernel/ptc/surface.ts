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
 *   - 模板串 ${} 插值内不检查（整串剥离——插值表达式漏报）；
 *   - 无点无括号的裸引用（const y = foo）不在扫描面——运行时 ReferenceError 兜底。
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

/** 剥离正则字面量/字符串/模板串/注释——其中内容不参与越界判定 */
export function stripNonCode(code: string): string {
  let s = code;
  // 正则字面量（启发式：非标识符前缀的 / … / flags——防 // 注释剥离误伤正则内的 /）
  s = s.replace(/(^|[^\w$)\]])(\/(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[a-z]*)/g, "$1/x/");
  // 字符串（单/双引号——含转义）
  s = s.replace(/'(\\.|[^'\\\n])*'|"(\\.|[^"\\\n])*"/g, '""');
  // 模板串（含插值——整串剥离：插值内漏报为已知边界）
  s = s.replace(/\`(?:\\[\s\S]|[^\`\\])*\`/g, '""');
  // 注释
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ");
  s = s.replace(/\/\/[^\n]*/g, " ");
  return s;
}

/** 收集安全名：声明/形参/解构——过度收集（漏报）是安全方向 */
function collectSafeNames(stripped: string, out: Set<string>): void {
  const idRe = /[A-Za-z_$][\w$]*/g;
  const addIdentifiers = (snippet: string) => {
    for (const m of snippet.matchAll(idRe)) out.add(m[0]!);
  };
  for (const m of stripped.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]!);
  for (const m of stripped.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) addIdentifiers(m[1]!);
  for (const m of stripped.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]!);
  for (const m of stripped.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]!);
  for (const m of stripped.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]!);
  for (const m of stripped.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]!);
  // 形参：function f(a, b) / 箭头 (a, b) => / 单参箭头 x =>
  for (const m of stripped.matchAll(/\bfunction\s*(?:[A-Za-z_$][\w$]*)?\s*\(([^()]*)\)/g)) addIdentifiers(m[1]!);
  for (const m of stripped.matchAll(/\(([^()]*)\)\s*=>/g)) addIdentifiers(m[1]!);
  for (const m of stripped.matchAll(/(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*=>/g)) out.add(m[1]!);
  // 方法/块头形参（含 if/for/while/switch/catch 头——过度收集无害）
  for (const m of stripped.matchAll(/\b[A-Za-z_$][\w$]*\s*\(([^()]*)\)\s*\{/g)) addIdentifiers(m[1]!);
}

/** 扫描成员访问根 + 直接调用根 → 越界根列表（knownGlobals = 注入面键集合） */
export function findOutOfBoundsRoots(code: string, knownGlobals: ReadonlySet<string>): string[] {
  const stripped = stripNonCode(code);
  const safe = new Set<string>();
  collectSafeNames(stripped, safe);
  const out = new Set<string>();
  const consider = (root: string) => {
    if (knownGlobals.has(root) || safe.has(root) || JS_BUILTINS.has(root) || JS_KEYWORDS.has(root)) return;
    out.add(root);
  };
  // 成员访问根：root.x / root?.x / root[...]（lookbehind 排除属主前的 . / ?. / ) / ]）
  for (const m of stripped.matchAll(/(?:^|[^\w$)\].?])([A-Za-z_$][\w$]*)\s*(?:\??\.|\[)/g)) consider(m[1]!);
  // 直接调用根：root( ——排除方法调用（前导 .）与调用结果（前导 )）
  for (const m of stripped.matchAll(/(?:^|[^\w$).])([A-Za-z_$][\w$]*)\s*\??\(/g)) consider(m[1]!);
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
