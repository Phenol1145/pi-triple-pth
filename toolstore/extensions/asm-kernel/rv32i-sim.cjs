/**
 * rv32i-sim.js —— RV32I 纯 JS 模拟器（asm-kernel 探索核——单文件自包含）
 *
 * asm-kernel 探索核：两遍汇编器 + 解释器（RV32I 核心子集）。
 * 纯 JS 实现（无系统工具链依赖）——设计 §3（memory kind=design-doc 2026-08-12）。
 *
 * 内存布局：code 段 [0x00000, 0x10000) 64KiB；data 段 [0x10000, 0x20000) 64KiB。
 * 寄存器：Int32Array(32)（x0 恒 0）；PC 逐条 +4；syscall 仅 write/exit。
 * 防失控：maxSteps=1_000_000（可配）/ timeoutMs=2000（可配）/ 内存 OOB 边界检查。
 *
 * 用法（Node 直接 require——单元测试/外部工具）：
 *   const { assemble, simulate, ISA } = require("./rv32i-sim.js");
 *   const a = assemble(src);            // { ok, code, entry, data, symbols, ... }
 *   const r = simulate(src);            // { ok, stdout, stderr, exitCode, steps, error? }
 *
 * ⚠ 与 index.js 中内嵌模拟器实现保持同步（eval 通道无 require——单文件约束）；
 *   v0.1 采用同源实现 + 本文件为权威测试面；后续引入构建步骤消除重复。
 */
"use strict";

// ─── 编码常量 ─────────────────────────────────────────────
const OP_LUI     = 0x37;
const OP_AUIPC   = 0x17;
const OP_JAL     = 0x6f;
const OP_JALR    = 0x67;
const OP_BRANCH  = 0x63;
const OP_LOAD    = 0x03;
const OP_STORE   = 0x23;
const OP_OP_IMM  = 0x13;
const OP_OP      = 0x33;
const OP_SYSTEM  = 0x73;

const CODE_BASE  = 0;
const CODE_SIZE  = 0x10000;          // 64KiB
const DATA_BASE  = 0x10000;          // 64KiB
const DATA_SIZE  = 0x10000;
const MEM_END    = DATA_BASE + DATA_SIZE;   // 128KiB 上限

const DEFAULT_MAX_STEPS = 1_000_000;
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_STDOUT = 4 * 1024 * 1024;  // 4MB 输出上限

/** 寄存器 ABI 名 → 编号（x0..x31 + 常用别名） */
const REG_NAMES = {
  zero: 0, ra: 1, sp: 2, gp: 3, tp: 4,
  t0: 5, t1: 6, t2: 7, s0: 8, fp: 8, s1: 9,
  a0: 10, a1: 11, a2: 12, a3: 13, a4: 14, a5: 15, a6: 16, a7: 17,
  s2: 18, s3: 19, s4: 20, s5: 21, s6: 22, s7: 23, s8: 24, s9: 25, s10: 26, s11: 27,
  t3: 28, t4: 29, t5: 30, t6: 31,
};

function regNum(tok, lineNo) {
  if (tok === undefined) throw new SimError(lineNo, `缺少寄存器操作数`);
  const t = String(tok).toLowerCase();
  if (/^x([0-9]|1[0-9]|2[0-9]|3[01])$/.test(t)) return Number(t.slice(1));
  if (t in REG_NAMES) return REG_NAMES[t];
  throw new SimError(lineNo, `未知寄存器 '${tok}'`);
}

function parseImm(tok, lineNo, bits) {
  if (tok === undefined) throw new SimError(lineNo, `缺少立即数`);
  const t = String(tok).toLowerCase();
  let v;
  if (/^0x[0-9a-f]+$/.test(t)) v = Number.parseInt(t, 16);
  else if (/^-?[0-9]+$/.test(t)) v = Number.parseInt(t, 10);
  else return { sym: String(tok) };                       // 符号（两遍汇编第二遍解析）
  const min = -Math.pow(2, bits - 1), max = Math.pow(2, bits - 1) - 1;
  if (v < min || v > max) throw new SimError(lineNo, `立即数 ${tok} 超出 ${bits} 位有符号范围 [${min}, ${max}]`);
  return { v };
}

/** li 专用：接受 32 位无符号（0..0xFFFFFFFF），内部转为有符号 */
function parseLiImm(tok, lineNo) {
  if (tok === undefined) throw new SimError(lineNo, `缺少立即数`);
  const t = String(tok).toLowerCase();
  if (/^0x[0-9a-f]+$/.test(t) || /^-?[0-9]+$/.test(t)) {
    let v = Number.parseInt(t, 0);
    if (v < -2147483648 || v > 4294967295) throw new SimError(lineNo, `立即数 ${tok} 超出 32 位范围`);
    return { v: v | 0 };                                 // 截断为有符号 32 位（与 parseImm 同构）
  }
  return { sym: String(tok) };                           // 符号 → 绝对地址
}

class SimError extends Error {
  constructor(line, msg) { super(msg); this.line = line; this.name = "SimError"; }
}

// ─── 工具函数 ─────────────────────────────────────────────
function sext12(v) { return (v & 0x800) ? (v | 0xfffff000) : v; }
function sext13(v) { return (v & 0x1000) ? (v | 0xffffe000) : v; }
function sext21(v) { return (v & 0x100000) ? (v | 0xffe00000) : v; }

/** 拆一条指令（RISC-V 常见紧凑语法）：处理 "lw x1, 4(x2)" / "addi x1, x2, 3" / "jalr x1, x2, 4" */
function splitOperands(tokens, lineNo) {
  // tokens: 已按空白拆分；再处理括号内的偏移
  const out = [];
  for (const tk of tokens) {
    const m = /^([+-]?(?:0x[0-9a-f]+|[0-9]+))\(([^)]+)\)$/.exec(tk);
    if (m) { out.push(m[2]); out.push(m[1]); }            // (off)reg → reg, off
    else out.push(tk);
  }
  return out;
}

// ─── 指令表（编码元数据）─────────────────────────────────────
// R 型：{ f: "R", op, f3, f7 }
const R_TYPE = {
  add:  { op: OP_OP,  f3: 0, f7: 0x00 }, sub: { op: OP_OP, f3: 0, f7: 0x20 },
  sll:  { op: OP_OP,  f3: 1, f7: 0x00 }, slt: { op: OP_OP, f3: 2, f7: 0x00 },
  sltu: { op: OP_OP,  f3: 3, f7: 0x00 }, xor: { op: OP_OP, f3: 4, f7: 0x00 },
  srl:  { op: OP_OP,  f3: 5, f7: 0x00 }, sra: { op: OP_OP, f3: 5, f7: 0x20 },
  or:   { op: OP_OP,  f3: 6, f7: 0x00 }, and: { op: OP_OP, f3: 7, f7: 0x00 },
};
// I 型：{ f: "I", op, f3 }；shamt 型 slli/srli/srai 用 f7 区分
const I_TYPE = {
  addi:  { op: OP_OP_IMM, f3: 0 }, slti:  { op: OP_OP_IMM, f3: 2 }, sltiu: { op: OP_OP_IMM, f3: 3 },
  xori:  { op: OP_OP_IMM, f3: 4 }, ori:   { op: OP_OP_IMM, f3: 6 }, andi:  { op: OP_OP_IMM, f3: 7 },
  slli:  { op: OP_OP_IMM, f3: 1, sh: 0 }, srli: { op: OP_OP_IMM, f3: 5, sh: 0 }, srai: { op: OP_OP_IMM, f3: 5, sh: 0x20 },
  lb:    { op: OP_LOAD,   f3: 0 }, lw:    { op: OP_LOAD,   f3: 2 },
  jalr:  { op: OP_JALR,   f3: 0 },
};
// S 型
const S_TYPE = {
  sb: { op: OP_STORE, f3: 0 }, sw: { op: OP_STORE, f3: 2 },
};
// B 型
const B_TYPE = {
  beq: { op: OP_BRANCH, f3: 0 }, bne: { op: OP_BRANCH, f3: 1 },
  blt: { op: OP_BRANCH, f3: 4 }, bge: { op: OP_BRANCH, f3: 5 },
  bltu:{ op: OP_BRANCH, f3: 6 }, bgeu:{ op: OP_BRANCH, f3: 7 },
};
// U/J 型
const U_TYPE = { lui: { op: OP_LUI }, auipc: { op: OP_AUIPC } };
const J_TYPE = { jal: { op: OP_JAL } };
// SYSTEM
const SYSTEM = { ecall: 0, ebreak: 1 };

/** 伪指令（pass1 计算尺寸 / pass2 展开） */
const PSEUDO = new Set(["li", "mv", "nop", "la", "call", "ret", "j"]);

const INSTR_MAP = {};
for (const [k, v] of Object.entries(R_TYPE)) INSTR_MAP[k] = { ...v, f: "R" };
for (const [k, v] of Object.entries(I_TYPE)) INSTR_MAP[k] = { ...v, f: "I" };
for (const [k, v] of Object.entries(S_TYPE)) INSTR_MAP[k] = { ...v, f: "S" };
for (const [k, v] of Object.entries(B_TYPE)) INSTR_MAP[k] = { ...v, f: "B" };
for (const [k, v] of Object.entries(U_TYPE)) INSTR_MAP[k] = { ...v, f: "U" };
for (const [k, v] of Object.entries(J_TYPE)) INSTR_MAP[k] = { ...v, f: "J" };
for (const [k, v] of Object.entries(SYSTEM)) INSTR_MAP[k] = { f: "SYSTEM", code: v };

const ISA_SUMMARY = [
  "R: add sub sll srl sra and or xor slt sltu",
  "I: addi slti sltiu xori ori andi slli srli srai lb lw lui auipc jalr",
  "S: sb sw | B: beq bne blt bge bltu bgeu | U/J: jal",
  "SYSTEM: ecall(write=64/exit=93) ebreak",
  "伪指令: li mv nop la call ret j",
  "节: .text .data .ascii .asciz .word .byte .align .space .globl(忽略)",
].join("\n");

// ─── 两遍汇编器 ─────────────────────────────────────────────
/**
 * 解析一行 → { kind: "directive"|"label"|"inst"|"empty", ... }
 */
function parseLine(line, lineNo) {
  const hash = line.indexOf("#");
  const clean = (hash >= 0 ? line.slice(0, hash) : line).trim();
  if (!clean) return { kind: "empty" };
  // 引号字符串保护（.ascii/.asciz 内可能含空白/逗号）
  const toks = [];
  let i = 0;
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === " " || ch === "\t" || ch === ",") { i++; continue; }
    if (ch === '"') {
      let j = i + 1, s = "";
      while (j < clean.length && clean[j] !== '"') {
        if (clean[j] === "\\" && j + 1 < clean.length) {
          const esc = clean[j + 1];
          s += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "0" ? "\0" : esc;
          j += 2;
        } else { s += clean[j]; j++; }
      }
      if (j >= clean.length) throw new SimError(lineNo, `字符串未闭合: ${line.trim()}`);
      toks.push({ str: s });
      i = j + 1;
    } else {
      let j = i;
      while (j < clean.length && !" \t,".includes(clean[j])) j++;
      toks.push(clean.slice(i, j));
      i = j;
    }
  }
  // 标签？
  if (toks.length && typeof toks[0] === "string" && toks[0].endsWith(":")) {
    const name = toks[0].slice(0, -1);
    if (!/^[A-Za-z_.$][A-Za-z0-9_.$]*$/.test(name)) throw new SimError(lineNo, `非法标签名 '${name}'`);
    return { kind: "label", name, rest: toks.slice(1) };
  }
  if (toks.length && typeof toks[0] === "string" && toks[0].startsWith(".")) {
    return { kind: "directive", name: toks[0].toLowerCase(), args: toks.slice(1) };
  }
  if (toks.length && typeof toks[0] === "string") {
    return { kind: "inst", mnemonic: toks[0].toLowerCase(), args: toks.slice(1) };
  }
  return { kind: "empty" };
}

function directiveSize(dir, args, lineNo) {
  switch (dir) {
    case ".text": case ".data": case ".globl": case ".global": case ".section": case ".type": case ".size": return 0;
    case ".align": {
      const n = Number(args[0]);
      if (!Number.isInteger(n) || n < 0 || n > 16) throw new SimError(lineNo, `.align 需要 0..16 的整数`);
      return -1; // 特殊：对齐（需当前偏移）
    }
    case ".word": return args.filter((a) => typeof a === "string").length * 4;
    case ".byte": return args.filter((a) => typeof a === "string").length;
    case ".ascii": case ".asciz": {
      let n = 0;
      for (const a of args) n += a.str ? Buffer.byteLength(a.str) : 0;
      return dir === ".asciz" ? n + 1 : n;
    }
    case ".space": {
      const n = Number(args[0]);
      if (!Number.isInteger(n) || n < 0) throw new SimError(lineNo, `.space 需要非负整数`);
      return n;
    }
    default: throw new SimError(lineNo, `未知节指令 '${dir}'`);
  }
}

/** 指令编码尺寸（伪指令按展开后尺寸） */
function instSize(mnemonic, args, lineNo) {
  if (!INSTR_MAP[mnemonic] && !PSEUDO.has(mnemonic)) throw new SimError(lineNo, `未知助记符 '${mnemonic}'`);
  if (mnemonic === "li") {
    const t = args[1];
    let num = typeof t === "string" && /^-?(0x[0-9a-f]+|[0-9]+)$/i.test(t) ? Number.parseInt(t, 0) : null;
    if (num !== null && num > 2147483647) num = (num | 0);     // 32 位无符号字面量 → 有符号
    if (num !== null && num >= -2048 && num <= 2047) return 4;
    return 8;
  }
  if (mnemonic === "la" || mnemonic === "call") return 8;
  return 4;
}

/** 第一遍：标号定址 + 尺寸累计 */
function firstPass(lines) {
  const symbols = {};       // 标签 → 绝对字节地址（code 段绝对 0 基；data 段 DATA_BASE 基）
  let section = "text";
  let codeOff = 0, dataOff = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const p = parseLine(lines[i], lineNo);
    if (p.kind === "empty") continue;
    if (p.kind === "directive") {
      if (p.name === ".text") { section = "text"; continue; }
      if (p.name === ".data") { section = "data"; continue; }
      if (p.name === ".globl" || p.name === ".global" || p.name === ".section" || p.name === ".type" || p.name === ".size") continue;
      const sz = directiveSize(p.name, p.args, lineNo);
      if (p.name === ".align") {
        const n = Number(p.args[0]);
        if (section === "text") codeOff = (codeOff + (1 << n) - 1) & ~((1 << n) - 1);
        else dataOff = (dataOff + (1 << n) - 1) & ~((1 << n) - 1);
        continue;
      }
      if (section === "text") {
        if (p.name === ".word" || p.name === ".byte" || p.name === ".ascii" || p.name === ".asciz" || p.name === ".space")
          codeOff += sz;    // 文本段内嵌数据（原始字）
        else throw new SimError(lineNo, `指令 '${p.name}' 仅可出现在 .data 段`);
      } else dataOff += sz;
      continue;
    }
    if (p.kind === "label") {
      const addr = section === "text" ? codeOff : DATA_BASE + dataOff;
      symbols[p.name] = addr;
      if (p.rest.length) {
        const first = p.rest[0];
        if (typeof first === "string" && first.startsWith(".")) {
          const d = first.toLowerCase();
          const sz = directiveSize(d, p.rest.slice(1), lineNo);
          if (d === ".align") {
            const n = Number(p.rest[1]);
            if (section === "text") codeOff = (codeOff + (1 << n) - 1) & ~((1 << n) - 1);
            else dataOff = (dataOff + (1 << n) - 1) & ~((1 << n) - 1);
          } else if (section === "text" && [".word", ".byte", ".ascii", ".asciz", ".space"].includes(d)) codeOff += sz;
          else if (section === "data") dataOff += sz;
          else if (d === ".globl" || d === ".global" || d === ".section" || d === ".type" || d === ".size") { /* 忽略 */ }
          else throw new SimError(lineNo, `指令 '${d}' 仅可出现在 .data 段`);
        } else if (typeof first === "string") {
          if (section !== "text") throw new SimError(lineNo, `指令出现在 .data 段`);
          codeOff += instSize(first.toLowerCase(), p.rest.slice(1), lineNo);
        } else throw new SimError(lineNo, `标签行语法错误`);
      }
      continue;
    }
    // inst
    if (section !== "text") throw new SimError(lineNo, `指令出现在 .data 段（'${p.mnemonic}'）`);
    codeOff += instSize(p.mnemonic, p.args, lineNo);
  }
  if (codeOff > CODE_SIZE) throw new SimError(0, `代码段超限 ${codeOff} > ${CODE_SIZE}（64KiB）`);
  if (dataOff > DATA_SIZE) throw new SimError(0, `数据段超限 ${dataOff} > ${DATA_SIZE}（64KiB）`);
  return { symbols, codeSize: codeOff, dataSize: dataOff };
}

function encodeR(meta, rd, rs1, rs2) { return ((meta.f7 & 0x7f) << 25) | ((rs2 & 0x1f) << 20) | ((rs1 & 0x1f) << 15) | ((meta.f3 & 0x7) << 12) | ((rd & 0x1f) << 7) | meta.op; }
function encodeI(meta, rd, rs1, imm) { return ((imm & 0xfff) << 20) | ((rs1 & 0x1f) << 15) | ((meta.f3 & 0x7) << 12) | ((rd & 0x1f) << 7) | meta.op; }
function encodeS(meta, rs2, rs1, imm) { return (((imm >> 5) & 0x7f) << 25) | ((rs2 & 0x1f) << 20) | ((rs1 & 0x1f) << 15) | ((meta.f3 & 0x7) << 12) | ((imm & 0x1f) << 7) | meta.op; }
function encodeB(meta, rs1, rs2, imm) { return (((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | ((rs2 & 0x1f) << 20) | ((rs1 & 0x1f) << 15) | ((meta.f3 & 0x7) << 12) | (((imm >> 1) & 0xf) << 8) | (((imm >> 11) & 1) << 7) | meta.op; }
function encodeU(meta, rd, imm) { return ((imm & 0xfffff) << 12) | ((rd & 0x1f) << 7) | meta.op; }  // imm = 20 位高位立即数
function encodeJ(meta, rd, imm) { return (((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) | (((imm >> 11) & 1) << 20) | (((imm >> 12) & 0xff) << 12) | ((rd & 0x1f) << 7) | meta.op; }

/** 第二遍：编码 → Uint8Array(code) + Uint8Array(data) */
function secondPass(lines, ctx) {
  const codeWords = [];
  const dataBytes = [];
  const { symbols } = ctx;
  let section = "text";
  let pc = 0;

  const resolveImm = (tok, lineNo, bits) => {
    const r = parseImm(tok, lineNo, bits);
    if (r.sym !== undefined) {
      if (!(r.sym in symbols)) throw new SimError(lineNo, `未定义标签 '${r.sym}'`);
      return symbols[r.sym];
    }
    return r.v;
  };
  const resolveBranch = (tok, lineNo, bits) => {
    const r = parseImm(tok, lineNo, bits);
    if (r.sym !== undefined && !(r.sym in symbols)) throw new SimError(lineNo, `未定义标签 '${r.sym}'`);
    const target = r.sym !== undefined ? symbols[r.sym] : r.v;
    const off = target - pc;
    const min = -(1 << (bits - 1)), max = (1 << (bits - 1)) - 1;
    if (off < min || off > max) throw new SimError(lineNo, `分支/跳转偏移 ${off} 超出 ${bits} 位范围（标签 '${tok}' 距 PC=${pc} 过远）`);
    return off;
  };

  const emitWord = (w, lineNo) => {
    const v = w >>> 0;
    codeWords.push(v);
    pc += 4;
    if (codeWords.length * 4 > CODE_SIZE) throw new SimError(lineNo, `代码段超限`);
  };

  const emitTextBytes = (bytes) => {
    for (const b of bytes) { codeWords.push(b); }
    pc += bytes.length;
  };

  // 伪指令展开
  const expandPseudo = (mn, args, lineNo) => {
    if (mn === "nop") { emitWord(encodeI(I_TYPE.addi, 0, 0, 0), lineNo); return; }
    if (mn === "ret") { emitWord(encodeI(I_TYPE.jalr, 0, 1, 0), lineNo); return; }
    if (mn === "mv") {
      const rd = regNum(args[0], lineNo), rs = regNum(args[1], lineNo);
      emitWord(encodeI(I_TYPE.addi, rd, rs, 0), lineNo); return;
    }
    if (mn === "li") {
      const rd = regNum(args[0], lineNo);
      const r = parseLiImm(args[1], lineNo);
      let imm = r.sym !== undefined ? symbols[r.sym] : r.v;
      if (imm >= -2048 && imm <= 2047) { emitWord(encodeI(I_TYPE.addi, rd, 0, imm & 0xfff), lineNo); return; }
      let hi = imm >> 12;
      if (imm & 0x800) hi += 1;
      const lo = imm - (hi << 12);
      emitWord(encodeU(U_TYPE.lui, rd, hi & 0xfffff), lineNo);
      emitWord(encodeI(I_TYPE.addi, rd, rd, lo & 0xfff), lineNo); return;
    }
    if (mn === "la") {
      const rd = regNum(args[0], lineNo);
      if (!(args[1] in symbols)) throw new SimError(lineNo, `未定义标签 '${args[1]}'`);
      const addr = symbols[args[1]];
      let hi = addr >> 12;
      if (addr & 0x800) hi += 1;
      const lo = addr - (hi << 12);
      emitWord(encodeU(U_TYPE.lui, rd, hi & 0xfffff), lineNo);
      emitWord(encodeI(I_TYPE.addi, rd, rd, lo & 0xfff), lineNo); return;
    }
    if (mn === "j") {
      const off = resolveBranch(args[0], lineNo, 21);
      emitWord(encodeJ(J_TYPE.jal, 0, off & 0x1fffff), lineNo); return;
    }
    if (mn === "call") {
      if (!(args[0] in symbols)) throw new SimError(lineNo, `未定义标签 '${args[0]}'`);
      const target = symbols[args[0]];
      const rel = target - pc;                       // auipc 以自身 pc 为基
      let hi = rel >> 12;
      if (rel & 0x800) hi += 1;
      const lo = rel - (hi << 12);
      emitWord(encodeU(U_TYPE.auipc, 1, hi & 0xfffff), lineNo);
      emitWord(encodeI(I_TYPE.jalr, 1, 1, lo & 0xfff), lineNo); return;
    }
    throw new SimError(lineNo, `伪指令 '${mn}' 展开失败`);
  };

  const emitDirectiveTokens = (dir, args, lineNo) => {
    if (dir === ".text") { section = "text"; return; }
    if (dir === ".data") { section = "data"; return; }
    if (dir === ".globl" || dir === ".global" || dir === ".section" || dir === ".type" || dir === ".size") return;
    if (dir === ".align") {
      const n = Number(args[0]);
      if (section === "text") {
        const cur = codeWords.length * 4;
        const aligned = (cur + (1 << n) - 1) & ~((1 << n) - 1);
        while (codeWords.length * 4 < aligned) emitWord(0, lineNo);
      } else {
        const aligned = (dataBytes.length + (1 << n) - 1) & ~((1 << n) - 1);
        while (dataBytes.length < aligned) dataBytes.push(0);
      }
      return;
    }
    const pushData = (bytes) => { for (const b of bytes) dataBytes.push(b); };
    if (dir === ".word") {
      const vals = [];
      for (const a of args) { const r = parseImm(a, lineNo, 32); vals.push((r.sym !== undefined ? symbols[r.sym] : r.v) >>> 0); }
      if (section === "text") { for (const v of vals) emitWord(v, lineNo); }
      else { for (const v of vals) pushData([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]); }
      return;
    }
    if (dir === ".byte") {
      const vals = [];
      for (const a of args) { const r = parseImm(a, lineNo, 8); vals.push((r.sym !== undefined ? symbols[r.sym] : r.v) & 0xff); }
      if (section === "text") { for (const v of vals) emitWord(v, lineNo); }
      else { for (const v of vals) pushData([v]); }
      return;
    }
    if (dir === ".ascii" || dir === ".asciz") {
      let bytes = [];
      for (const a of args) if (a.str) bytes = bytes.concat(Array.from(Buffer.from(a.str, "utf8")));
      if (dir === ".asciz") bytes.push(0);
      if (section === "text") {
        while (bytes.length % 4) bytes.push(0);
        for (let k = 0; k < bytes.length; k += 4) emitWord(bytes[k] | (bytes[k + 1] << 8) | (bytes[k + 2] << 16) | (bytes[k + 3] << 24), lineNo);
      } else pushData(bytes);
      return;
    }
    if (dir === ".space") {
      const n = Number(args[0]);
      if (section === "text") { for (let k = 0; k < n; k += 4) emitWord(0, lineNo); }
      else { pushData(new Array(n).fill(0)); }
      return;
    }
    throw new SimError(lineNo, `未知节指令 '${dir}'`);
  };

  const emitInstTokens = (mn, rawArgs, lineNo) => {
    const args = PSEUDO.has(mn) ? rawArgs : splitOperands(rawArgs, lineNo);   // "0(x6)" → ["x6","0"]
    if (PSEUDO.has(mn)) { expandPseudo(mn, args, lineNo); return; }
    const meta = INSTR_MAP[mn];
    if (!meta) throw new SimError(lineNo, `未知助记符 '${mn}'`);
    if (meta.f === "R") {
      const rd = regNum(args[0], lineNo), rs1 = regNum(args[1], lineNo), rs2 = regNum(args[2], lineNo);
      emitWord(encodeR(meta, rd, rs1, rs2), lineNo);
    } else if (meta.f === "I") {
      if (meta.sh !== undefined) {                 // slli/srli/srai
        const rd = regNum(args[0], lineNo), rs1 = regNum(args[1], lineNo);
        const r = parseImm(args[2], lineNo, 5);
        const sh = r.sym !== undefined ? symbols[r.sym] : r.v;
        const imm = ((meta.sh ? 0x20 : 0) << 5) | (sh & 0x1f);
        emitWord(encodeI(meta, rd, rs1, imm), lineNo);
      } else {
        const rd = regNum(args[0], lineNo), rs1 = regNum(args[1], lineNo);
        const imm = resolveImm(args[2], lineNo, 12);
        emitWord(encodeI(meta, rd, rs1, imm & 0xfff), lineNo);
      }
    } else if (meta.f === "S") {
      const rs2 = regNum(args[0], lineNo), rs1 = regNum(args[1], lineNo);
      const imm = resolveImm(args[2], lineNo, 12);
      emitWord(encodeS(meta, rs2, rs1, imm & 0xfff), lineNo);
    } else if (meta.f === "B") {
      const rs1 = regNum(args[0], lineNo), rs2 = regNum(args[1], lineNo);
      const off = resolveBranch(args[2], lineNo, 13);
      emitWord(encodeB(meta, rs1, rs2, off & 0x1fff), lineNo);
    } else if (meta.f === "U") {
      const rd = regNum(args[0], lineNo);
      const imm = resolveImm(args[1], lineNo, 20);
      emitWord(encodeU(meta, rd, imm), lineNo);
    } else if (meta.f === "J") {
      const rd = args.length >= 2 ? regNum(args[0], lineNo) : 1;
      const labTok = args.length >= 2 ? args[1] : args[0];
      const off = resolveBranch(labTok, lineNo, 21);
      emitWord(encodeJ(meta, rd, off & 0x1fffff), lineNo);
    } else if (meta.f === "SYSTEM") {
      if (args.length) throw new SimError(lineNo, `ecall/ebreak 无操作数`);
      emitWord(((meta.code & 0xfff) << 20) | OP_SYSTEM, lineNo);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const p = parseLine(lines[i], lineNo);
    if (p.kind === "empty") continue;
    if (p.kind === "directive") { emitDirectiveTokens(p.name, p.args, lineNo); continue; }
    if (p.kind === "label") {
      if (p.rest.length) {
        const first = p.rest[0];
        if (typeof first === "string" && first.startsWith(".")) emitDirectiveTokens(first.toLowerCase(), p.rest.slice(1), lineNo);
        else if (typeof first === "string") emitInstTokens(first.toLowerCase(), p.rest.slice(1), lineNo);
        else throw new SimError(lineNo, `标签行语法错误`);
      }
      continue;
    }
    emitInstTokens(p.mnemonic, p.args, lineNo);
  }

  const code = Uint8Array.from(codeWords.length * 4 ? (() => { const b = new Uint8Array(codeWords.length * 4); codeWords.forEach((w, k) => { b[k * 4] = w & 0xff; b[k * 4 + 1] = (w >> 8) & 0xff; b[k * 4 + 2] = (w >> 16) & 0xff; b[k * 4 + 3] = (w >> 24) & 0xff; }); return b; })() : new Uint8Array(0));
  const data = Uint8Array.from(dataBytes);
  return { code, data };
}

/**
 * 两遍汇编入口
 * @param {string} source 汇编源码
 * @returns {{ok: boolean; code?: Uint8Array; data?: Uint8Array; entry?: number; symbols?: Record<string, number>; codeSize?: number; dataSize?: number; error?: string; line?: number}}
 */
function assemble(source) {
  try {
    if (typeof source !== "string" || !source.trim()) throw new SimError(0, "源码为空");
    const lines = source.split("\n");
    const p1 = firstPass(lines);
    const p2 = secondPass(lines, { symbols: p1.symbols });
    const entry = p1.symbols._start !== undefined ? p1.symbols._start : 0;
    return {
      ok: true, code: p2.code, data: p2.data, entry,
      symbols: p1.symbols, codeSize: p1.codeSize, dataSize: p1.dataSize,
    };
  } catch (e) {
    if (e instanceof SimError) return { ok: false, error: e.message, line: e.line };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── 解释器 ─────────────────────────────────────────────
class SimRunError extends Error { constructor(msg, pc) { super(msg); this.pc = pc; } }

/**
 * 解释执行
 * @param {string | {code: Uint8Array; data?: Uint8Array; entry?: number}} input 源码或已汇编 program
 * @param {{maxSteps?: number; timeoutMs?: number; stdin?: string}} opts
 * @returns {{ok: boolean; stdout?: string; stderr?: string; exitCode?: number; steps?: number; error?: string}}
 */
function simulate(input, opts = {}) {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let program;
  if (typeof input === "string") {
    const a = assemble(input);
    if (!a.ok) return { ok: false, error: `汇编失败${a.line ? `（行 ${a.line}）` : ""}: ${a.error}` };
    program = a;
  } else program = input;

  const code = program.code ?? new Uint8Array(0);
  const data = program.data ?? new Uint8Array(0);
  const regs = new Int32Array(32);
  const dataMem = new Uint8Array(DATA_SIZE);
  dataMem.set(data.subarray(0, Math.min(data.length, DATA_SIZE)));

  let pc = program.entry ?? 0;
  let steps = 0;
  let stdout = "", stderr = "";
  const t0 = Date.now();

  const readMem = (addr, n) => {
    if (addr < 0 || addr + n > MEM_END) throw new SimRunError(`内存越界读 @0x${addr.toString(16)}（${n} 字节）——内存上限 128KiB`, pc);
    if (addr >= DATA_BASE) return dataMem.subarray(addr - DATA_BASE, addr - DATA_BASE + n);
    const start = addr - CODE_BASE;
    return code.subarray(start, start + n);   // 读代码区（只读）
  };
  const writeMem = (addr, bytes) => {
    if (addr < 0 || addr + bytes.length > MEM_END) throw new SimRunError(`内存越界写 @0x${addr.toString(16)}（${bytes.length} 字节）`, pc);
    if (addr < DATA_BASE) throw new SimRunError(`写只读代码区 @0x${addr.toString(16)}`, pc);
    dataMem.set(bytes, addr - DATA_BASE);
  };
  const rd32 = (addr) => { const b = readMem(addr, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) | 0; };
  const rdU32 = (addr) => rd32(addr) >>> 0;
  const wr32 = (addr, v) => { const u = v >>> 0; writeMem(addr, new Uint8Array([u & 0xff, (u >> 8) & 0xff, (u >> 16) & 0xff, (u >> 24) & 0xff])); };

  const setReg = (rd, v) => { if (rd !== 0) regs[rd] = v | 0; };

  while (true) {
    steps++;
    if (Date.now() - t0 > timeoutMs) return { ok: false, error: `模拟超时（${timeoutMs}ms 预算用尽 @step=${steps}）`, steps, stdout, stderr, exitCode: 1 };
    if (steps > maxSteps) return { ok: false, error: `执行步数超限（${maxSteps}）——疑似死循环（检查分支/循环条件；可用 maxSteps 调大或 timeoutMs 限制）`, steps, stdout, stderr, exitCode: 1 };
    if (pc < 0 || pc + 4 > code.length) return { ok: false, error: `PC 越界 @0x${(pc >>> 0).toString(16)}（code ${code.length}B）`, steps, stdout, stderr, exitCode: 1 };

    const w = rdU32(pc);
    const op = w & 0x7f, rd = (w >> 7) & 0x1f, f3 = (w >> 12) & 0x7, rs1 = (w >> 15) & 0x1f, rs2 = (w >> 20) & 0x1f, f7 = (w >> 25) & 0x7f;
    const immI = sext12(w >> 20);
    let next = pc + 4;
    try {
      switch (op) {
        case OP_OP: {
          const a = regs[rs1], b = regs[rs2];
          switch (f3) {
            case 0: setReg(rd, f7 & 0x20 ? a - b : a + b); break;
            case 1: setReg(rd, a << (b & 31)); break;
            case 2: setReg(rd, a < b ? 1 : 0); break;
            case 3: setReg(rd, (a >>> 0) < (b >>> 0) ? 1 : 0); break;
            case 4: setReg(rd, a ^ b); break;
            case 5: setReg(rd, f7 & 0x20 ? a >> (b & 31) : (a >>> (b & 31))); break;
            case 6: setReg(rd, a | b); break;
            case 7: setReg(rd, a & b); break;
            default: throw new SimRunError(`非法 R 型 funct3=${f3}`, pc);
          }
          break;
        }
        case OP_OP_IMM: {
          const a = regs[rs1];
          switch (f3) {
            case 0: setReg(rd, a + immI); break;
            case 1: setReg(rd, a << ((w >> 20) & 31)); break;
            case 2: setReg(rd, a < immI ? 1 : 0); break;
            case 3: setReg(rd, (a >>> 0) < (immI >>> 0) ? 1 : 0); break;
            case 4: setReg(rd, a ^ immI); break;
            case 5: setReg(rd, (w >> 30) & 1 ? a >> ((w >> 20) & 31) : (a >>> ((w >> 20) & 31))); break;
            case 6: setReg(rd, a | immI); break;
            case 7: setReg(rd, a & immI); break;
            default: throw new SimRunError(`非法 I 型 funct3=${f3}`, pc);
          }
          break;
        }
        case OP_LUI: setReg(rd, w & 0xfffff000); break;
        case OP_AUIPC: setReg(rd, (pc + (w & 0xfffff000)) | 0); break;
        case OP_JAL: {
          // J 型立即数散布于位 31/30:21/20/19:12——需按位重组（w>>11 是常见错误）
          const immJ = sext21(((w >> 31) << 20) | (((w >> 21) & 0x3ff) << 1) | (((w >> 20) & 1) << 11) | (((w >> 12) & 0xff) << 12));
          setReg(rd, next); next = pc + immJ; break;
        }
        case OP_JALR: {
          // 先算目标再写 rd（rd 与 rs1 同号（call/ret 用 ra）时顺序关键）
          const tgt = ((regs[rs1] + immI) & ~1);
          setReg(rd, next);
          next = tgt;
          break;
        }
        case OP_BRANCH: {
          const off = sext13(((w >> 31) << 12) | (((w >> 7) & 1) << 11) | (((w >> 25) & 0x3f) << 5) | (((w >> 8) & 0xf) << 1));
          const a = regs[rs1], b = regs[rs2];
          let t = false;
          switch (f3) {
            case 0: t = a === b; break;
            case 1: t = a !== b; break;
            case 4: t = a < b; break;
            case 5: t = a >= b; break;
            case 6: t = (a >>> 0) < (b >>> 0); break;
            case 7: t = (a >>> 0) >= (b >>> 0); break;
            default: throw new SimRunError(`非法 B 型 funct3=${f3}`, pc);
          }
          if (t) next = pc + off;
          break;
        }
        case OP_LOAD: {
          const addr = (regs[rs1] + immI) | 0;
          if (f3 === 0) { const b = readMem(addr, 1); setReg(rd, b[0] << 24 >> 24); }
          else if (f3 === 2) setReg(rd, rd32(addr));
          else throw new SimRunError(`不支持的 load funct3=${f3}（仅 lb/lw）`, pc);
          break;
        }
        case OP_STORE: {
          const addr = (regs[rs1] + sext12(((w >> 25) << 5) | ((w >> 7) & 0x1f))) | 0;
          if (f3 === 0) writeMem(addr, new Uint8Array([regs[rs2] & 0xff]));
          else if (f3 === 2) wr32(addr, regs[rs2]);
          else throw new SimRunError(`不支持的 store funct3=${f3}（仅 sb/sw）`, pc);
          break;
        }
        case OP_SYSTEM: {
          if (f3 !== 0) throw new SimRunError(`非法 SYSTEM funct3=${f3}`, pc);
          if ((w >> 20) === 1) return { ok: false, error: `ebreak 调试断点 @pc=0x${pc.toString(16)}`, steps, stdout, stderr, exitCode: 1 };
          const a7 = regs[17];
          if (a7 === 64) {                          // write(fd=a0, buf=a1, len=a2)
            const fd = regs[10], buf = regs[11], len = regs[12];
            if (fd !== 1 && fd !== 2) throw new SimRunError(`write: 不支持 fd=${fd}（仅 1=stdout / 2=stderr）`, pc);
            if (len < 0) throw new SimRunError(`write: 非法长度 ${len}`, pc);
            if (buf < 0 || buf + len > MEM_END) throw new SimRunError(`write: 缓冲区越界 @0x${buf.toString(16)} len=${len}`, pc);
            const chunk = readMem(buf, len);
            let text = "";
            for (let k = 0; k < chunk.length; k++) text += String.fromCharCode(chunk[k]);
            if (fd === 2) { stderr += text; if (stderr.length > MAX_STDOUT) stderr = stderr.slice(0, MAX_STDOUT); }
            else { stdout += text; if (stdout.length > MAX_STDOUT) stdout = stdout.slice(0, MAX_STDOUT); }
            setReg(10, len);
          } else if (a7 === 93) {                   // exit(code=a0)
            return { ok: true, stdout, stderr, exitCode: regs[10] & 0xff, steps };
          } else {
            throw new SimRunError(`未知 syscall a7=${a7}（仅支持 write=64 / exit=93）`, pc);
          }
          break;
        }
        default:
          throw new SimRunError(`非法指令字 0x${w.toString(16)}（opcode=0x${op.toString(16)}）——可能执行到非指令数据`, pc);
      }
    } catch (e) {
      if (e instanceof SimRunError) return { ok: false, error: `${e.message}（@pc=0x${pc.toString(16)}）`, steps, stdout, stderr, exitCode: 1 };
      throw e;
    }
    pc = next;
  }
}

module.exports = {
  assemble, simulate,
  ARCH: "rv32i", version: "0.1.0",
  ISA: ISA_SUMMARY,
  CODE_BASE, CODE_SIZE, DATA_BASE, DATA_SIZE, MEM_END,
  DEFAULT_MAX_STEPS, DEFAULT_TIMEOUT_MS,
};
