#!/usr/bin/env node
// tool-server/bin/bf.mjs —— T2 内置 Brainfuck 演示解释器（T3 替换为生产 bf/bfc）。
import { readFileSync } from "node:fs";

const program = process.argv[2] ? readFileSync(process.argv[2], "utf8") : readFileSync(0, "utf8");
const cells = new Uint8Array(30000);
let ptr = 0;
let input = "";
try { input = readFileSync("/dev/stdin", "utf8"); } catch { /* 无输入 */ }
let inputPtr = 0;
const stack = [];
const jumps = new Map();
for (let i = 0; i < program.length; i += 1) {
  if (program[i] === "[") stack.push(i);
  if (program[i] === "]") {
    const open = stack.pop();
    if (open === undefined) throw new Error("unmatched ]");
    jumps.set(open, i);
    jumps.set(i, open);
  }
}
if (stack.length > 0) throw new Error("unmatched [");

let out = "";
for (let ip = 0; ip < program.length; ip += 1) {
  switch (program[ip]) {
    case ">": ptr = (ptr + 1) % cells.length; break;
    case "<": ptr = (ptr - 1 + cells.length) % cells.length; break;
    case "+": cells[ptr] = (cells[ptr] + 1) & 0xff; break;
    case "-": cells[ptr] = (cells[ptr] - 1) & 0xff; break;
    case ".": out += String.fromCharCode(cells[ptr]); break;
    case ",": cells[ptr] = input.charCodeAt(inputPtr++) & 0xff; break;
    case "[": if (cells[ptr] === 0) ip = jumps.get(ip)!; break;
    case "]": if (cells[ptr] !== 0) ip = jumps.get(ip)!; break;
    default: break;
  }
}
process.stdout.write(out);
