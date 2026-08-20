/**
 * toolstore/extensions/lean4-runtime/index.js — Lean 4 证明运行时扩展。
 *
 * 固定命令面：probe / check / buildProject。本扩展自身不执行任何 shell 文本，
 * 只提供结构化操作描述；真正的命令序列由 PTH lean4-runtime-adapter 以固定
 * 参数（lake build / lake env lean）驱动，工具链版本与 mathlib rev 由
 * deploy/professional-runtime-lock.json 钉死。
 */

export function probe() {
  return {
    id: "lean4-runtime",
    version: "0.1.0",
    operations: ["lake-build", "check-imports", "prove"],
  };
}

export function check(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "check: input must be an object" };
  }
  if (input.command !== undefined || input.argv !== undefined || input.shell !== undefined) {
    return { ok: false, error: "check: arbitrary command/argv/shell is forbidden" };
  }
  return { ok: true };
}

export function buildProject(input) {
  // 生产通道由 PTH adapter 以固定命令执行；此处只做输入面校验。
  const checked = check(input);
  if (!checked.ok) return checked;
  return { ok: true, operation: input.operation ?? "lake-build" };
}
