#!/usr/bin/env node
/**
 * bridge.js —— asm-sim 探索核（rv32i-sim.cjs）↔ Jupyter kernel 协议桥（v1）
 *
 * 职责：从 stdin / argv 读取 RV32I 汇编源码 → require 模拟器模块 →
 *       simulate(src, { timeoutMs }) → 将结果序列化为【单行 JSON】写 stdout。
 * 协议：kernel.py（ipykernel 子类）以子进程方式调用本桥并解析 stdout JSON。
 *
 * 输入（优先级从高到低）：
 *   1) node bridge.js --file <path>     —— 从文件读源码
 *   2) node bridge.js <path|源码>        —— 参数是存在的文件则读文件，否则视为内联源码
 *   3) node bridge.js -                 —— 显式从 stdin 读
 *   4) echo '<源码>' | node bridge.js    —— 无参数时默认读 stdin
 *
 * 选项：--timeout <ms>  覆盖 simulate 的 timeoutMs（缺省 2000——与模拟器默认一致）
 *
 * 输出约定：stdout 恒为单行 JSON（simulate() 原始返回对象
 *           {ok, stdout, stderr, exitCode, steps, error?}；桥自身失败时 {ok:false, error}）。
 *           退出码恒 0 —— 协议语义放在 JSON 内（ok 字段），非 JSON 内容绝不写 stdout。
 *
 * 模拟器定位：env PTH_ASM_SIM_PATH 优先（绝对路径）；缺省相对本文件 ../asm-kernel/rv32i-sim.cjs。
 * 护栏：模拟器自身有 timeoutMs/maxSteps/内存边界；本桥再加一层硬超时看门狗兜底。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var DEFAULT_TIMEOUT_MS = 2000;
var WATCHDOG_SLACK_MS = 5000;

function resolveSimPath() {
  var env = process.env.PTH_ASM_SIM_PATH;
  if (env && env.trim()) return path.resolve(env);
  return path.resolve(__dirname, '..', 'asm-kernel', 'rv32i-sim.cjs');
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fail(error) {
  emit({ ok: false, error: String(error) });
  process.exit(0);
}

function readStdin() {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (c) { chunks.push(c); });
    process.stdin.on('end', function () { resolve(chunks.join('')); });
    process.stdin.on('error', reject);
  });
}

async function main() {
  var argv = process.argv.slice(2);
  var timeoutMs = DEFAULT_TIMEOUT_MS;
  var src = null;          // null = 尚未提供（最后走 stdin）
  var wantStdin = false;

  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--timeout' && i + 1 < argv.length) {
      timeoutMs = parseInt(argv[++i], 10);
      if (!isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
    } else if (a === '--file' && i + 1 < argv.length) {
      src = fs.readFileSync(argv[++i], 'utf8');
      wantStdin = false;
    } else if (a === '--') {
      src = argv.slice(i + 1).join(' ');
      wantStdin = false;
      i = argv.length;
    } else if (a === '-') {
      wantStdin = true;
    } else if (src === null && !wantStdin) {
      src = fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : a;
    }
  }

  if (wantStdin || src === null) src = await readStdin();
  src = String(src);
  if (!src.trim()) return fail('空输入：未提供汇编源码');

  var simPath = resolveSimPath();
  var sim;
  try {
    sim = require(simPath);
  } catch (e) {
    return fail('无法加载模拟器模块 ' + simPath + ': ' + e.message);
  }
  if (!sim || typeof sim.simulate !== 'function') {
    return fail('模拟器模块 ' + simPath + ' 未导出 simulate 函数');
  }

  // 硬超时看门狗：模拟器自身有 timeoutMs/maxSteps 护栏，这里再兜底（防外部死锁）
  var watchdog = setTimeout(function () {
    fail('模拟超时（> ' + (timeoutMs + WATCHDOG_SLACK_MS) + 'ms）');
  }, timeoutMs + WATCHDOG_SLACK_MS);
  if (watchdog.unref) watchdog.unref();

  try {
    var result = await Promise.resolve(sim.simulate(src, { timeoutMs: timeoutMs }));
    emit(result);
  } catch (e) {
    fail('模拟器执行异常: ' + (e && e.message ? e.message : String(e)));
  } finally {
    clearTimeout(watchdog);
  }
}

main().catch(function (e) { fail(e.message); });
