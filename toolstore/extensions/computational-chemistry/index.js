/**
 * toolstore/extensions/computational-chemistry/index.js — 计算化学运行时扩展。
 * 固定命令面：probe / runPsi4 / runQuantumEspresso；输入文件由 PTH adapter
 * 服务端生成，扩展自身绝不接受 shell 文本、宿主路径或原始引擎命令。
 */
export function probe() {
  return { id: "computational-chemistry", version: "0.1.0", engines: ["psi4", "quantum-espresso"] };
}

export function check(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "check: input must be an object" };
  if (input.command !== undefined || input.argv !== undefined || input.shell !== undefined || input.path !== undefined) {
    return { ok: false, error: "check: command/argv/shell/path is forbidden" };
  }
  return { ok: true };
}

export function runPsi4(input) {
  const checked = check(input);
  if (!checked.ok) return checked;
  return { ok: true, engine: "psi4" };
}

export function runQuantumEspresso(input) {
  const checked = check(input);
  if (!checked.ok) return checked;
  return { ok: true, engine: "quantum-espresso" };
}
