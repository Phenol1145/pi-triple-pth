#!/usr/bin/env node
/**
 * 构建 index.js：从 rv32i-sim.cjs 抽取模拟器实现（剥离头部注释/"use strict"/尾部 module.exports）
 * 注入 index.js.template 的模拟器段标记——保持单一权威源（rv32i-sim.cjs）。
 * 用法：node test/build-index.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..");
const sim = fs.readFileSync(path.join(dir, "rv32i-sim.cjs"), "utf8");
const tpl = fs.readFileSync(path.join(dir, "index.js.template"), "utf8");
const marker = "/*__RV32I_SIM_SECTION__*/";
if (!tpl.includes(marker)) { console.error("template 缺标记"); process.exit(1); }

// 抽取模拟器主体：去掉头部注释块、'use strict'、尾部 module.exports 语句
let body = sim;
body = body.replace(/^\/\*\*[\s\S]*?\*\/\n/, "");          // 头部 doc 注释
body = body.replace(/^"use strict";\n/, "");               // use strict 指令
body = body.replace(/\nmodule\.exports = \{[\s\S]*?\};\s*$/, "\n");  // 尾部导出
const indent = body.split("\n").map((l) => "  " + l).join("\n");
const out = tpl.replace(marker, indent.trimEnd() + "\n");
fs.writeFileSync(path.join(dir, "index.js"), out, "utf8");
console.log(`index.js 构建完成：${out.split("\n").length} 行 / ${Buffer.byteLength(out)} 字节（模拟器 ${body.split("\n").length} 行注入）`);
