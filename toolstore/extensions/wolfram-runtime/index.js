/**
 * toolstore/extensions/wolfram-runtime/index.js — Wolfram 符号计算运行时扩展。
 *
 * 固定命令面：probe / evaluate / verify。真实执行由 PTH wolfram-runtime-adapter
 * 以固定 `.wl` 文件协议驱动（表达式 JSON 转义 + ToExpression[..., InputForm]）；
 * 本扩展绝不接受 shell 文本或任意文件导入。license 数据永不进入本模块。
 */
export function probe() {
  return {
    id: "wolfram-runtime",
    version: "0.1.0",
    operations: ["evaluate", "verify"],
  };
}

export function check(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "check: input must be an object" };
  }
  if (input.command !== undefined || input.shell !== undefined || input.importPath !== undefined) {
    return { ok: false, error: "check: command/shell/importPath is forbidden" };
  }
  return { ok: true };
}

export function evaluate(input) {
  const checked = check(input);
  if (!checked.ok) return checked;
  if (typeof input.expression !== "string" || input.expression.length === 0) {
    return { ok: false, error: "evaluate: expression must be a non-empty Wolfram language string" };
  }
  return { ok: true, operation: "evaluate" };
}

export function verify(input) {
  const checked = evaluate(input);
  if (!checked.ok) return checked;
  return { ok: true, operation: "verify" };
}
