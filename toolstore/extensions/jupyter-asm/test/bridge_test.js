#!/usr/bin/env node
/**
 * bridge_test.js —— bridge.js 集成测试（node 环境直接跑——容器内可执行）
 *
 * 用法：PTH_ASM_SIM_PATH=<rv32i-sim.js 绝对路径> node test/bridge_test.js [bridge路径]
 * 用例覆盖：
 *   1) 验收样例：li a0,42 / li a7,93 / ecall → ok=true, exitCode=42
 *   2) write syscall：stdout="hi\n" 流转 → ok=true, stdout 匹配
 *   3) 坏汇编：ok=false, error 非空
 *   4) 非零退出码（exit=5）→ 仍是 ok=true（exitCode 是数据非状态——kernel 映射依据）
 */
'use strict';
var path = require('path');
var spawnSync = require('child_process').spawnSync;

var bridge = process.argv[2] || path.resolve(__dirname, '..', 'bridge.js');
if (!require('fs').existsSync(bridge)) {
  console.error('FAIL: 找不到 bridge.js:', bridge);
  process.exit(1);
}

var cases = [
  {
    name: 'acceptance: exit(42) → ok=true exitCode=42',
    src: 'li a0, 42\nli a7, 93\necall',
    expect: { ok: true, exitCode: 42 }
  },
  {
    name: 'write syscall → stdout="hi\\n" 流转',
    src: '.data\nmsg: .ascii "hi\\n"\n.text\nla a1, msg\nli a0, 1\nli a2, 3\nli a7, 64\necall\nli a0, 0\nli a7, 93\necall',
    expect: { ok: true, stdout: 'hi\n' }
  },
  {
    name: 'exit(5) → 非零退出码仍 ok=true',
    src: 'li a0, 5\nli a7, 93\necall',
    expect: { ok: true, exitCode: 5 }
  },
  {
    name: '坏汇编 → ok=false error 非空',
    src: 'lui x1',
    expect: { ok: false }
  },
  {
    name: 'argv 内联源码路径（-- 显式）',
    argv: ['--', 'li a0, 7\nli a7, 93\necall'],
    expect: { ok: true, exitCode: 7 }
  }
];

var failed = 0;
cases.forEach(function (c) {
  var args = c.argv || [];
  var r = spawnSync(process.execPath, [bridge].concat(args),
                    { input: args.length ? undefined : c.src, encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) {
    failed++;
    console.error('FAIL', c.name, ': bridge 退出码', r.status, 'stderr:', (r.stderr || '').slice(0, 200));
    return;
  }
  var out;
  try { out = JSON.parse(r.stdout); }
  catch (e) { failed++; console.error('FAIL', c.name, ': 非 JSON 输出:', r.stdout.slice(0, 200)); return; }
  var ok = Object.keys(c.expect).every(function (k) { return out[k] === c.expect[k]; });
  if (ok) console.log('PASS', c.name, '→', JSON.stringify(out));
  else { failed++; console.error('FAIL', c.name, '→ 期望', JSON.stringify(c.expect), '实际', JSON.stringify(out)); }
});

if (failed) { console.error('bridge_test: ' + failed + ' 个用例失败'); process.exit(1); }
console.log('bridge_test: 全部 ' + cases.length + ' 个用例通过 ✔');
