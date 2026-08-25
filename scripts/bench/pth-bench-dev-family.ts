#!/usr/bin/env tsx
/**
 * scripts/bench/pth-bench-dev-family.ts —— developer 族工作能力评估套件（2026-08-25）。
 *
 * 范围：developer 及其直接子类型 coder / tester（assembly-engineer 为专业角色、
 * debug-case-writer 为 tester 子类型——本套件不覆盖）。每角色 5 个确定性小任务，
 * 判分 = status(completed) + value（标量字段精确匹配）。
 *
 * 设计约束：
 * - 任务文本自包含、无 done 机制提示（兼作 W3 done 函数化后的自然收敛验收）；
 * - value 判分只用标量（string/number/boolean）——core.ts approxEq 无深比较；
 * - tags 用角色注册标签精确路由（developer=code / coder=coding / tester=test）。
 *
 * 用法（三条角色道并行）：
 *   PTH_TOKEN=... npx tsx scripts/bench/pth-bench-dev-family.ts developer > /tmp/bench-developer.json
 *   PTH_TOKEN=... npx tsx scripts/bench/pth-bench-dev-family.ts coder > /tmp/bench-coder.json
 *   PTH_TOKEN=... npx tsx scripts/bench/pth-bench-dev-family.ts tester > /tmp/bench-tester.json
 */

import { HttpBenchDriver, runSuite } from "../../src/pth/bench/index.js";
import type { BenchScenario } from "../../src/pth/bench/index.js";

const baseUrl = process.env.PTH_API ?? "http://localhost:3000";
const token = process.env.PTH_TOKEN ?? "";

const SUBMIT = "最终结果以 JSON 对象提交。";

const SCENARIOS: Record<string, BenchScenario[]> = {
  developer: [
    {
      id: "dev-prime-count",
      title: "用 ts 实现素数筛，统计 1..100 内素数个数与最大素数，自行运行验证。" + SUBMIT + '字段：{"count": 数量, "max": 最大素数}',
      tags: ["code"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "count", equals: 25 },
        { kind: "value", path: "max", equals: 97 },
      ],
    },
    {
      id: "dev-word-freq",
      title: '对文本 "the quick brown fox jumps over the lazy dog the fox the dog" 按空格分词统计词频。' + SUBMIT + '字段：{"topWord": 最高频词, "count": 次数}',
      tags: ["code"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "topWord", equals: "the" },
        { kind: "value", path: "count", equals: 4 },
      ],
    },
    {
      id: "dev-json-write",
      title: '在任务工作区写入 settings.json（紧凑单行 {"port":8080,"debug":false,"name":"bench"}），读回解析校验三字段一致。' + SUBMIT + '字段：{"port": 端口, "verified": 是否通过}',
      tags: ["code"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "port", equals: 8080 },
        { kind: "value", path: "verified", equals: true },
      ],
    },
    {
      id: "dev-bugfix-sum",
      title: "函数 sumTo(n){ let s=0; for(let i=0;i<=n+1;i++) s+=i; return s } 有 bug（sumTo(10) 应得 55 实得 66）。修复并用 n=0,1,10,50,100 五用例验证。" + SUBMIT + '字段：{"fixed": 是否修复, "testsPassed": 通过数}',
      tags: ["code"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "fixed", equals: true },
        { kind: "value", path: "testsPassed", equals: 5 },
      ],
    },
    {
      id: "dev-fizzbuzz-count",
      title: "实现 FizzBuzz（3 倍数 Fizz、5 倍数 Buzz、15 倍数 FizzBuzz），统计 1..100 三类数量。" + SUBMIT + '字段：{"fizzCount": 数, "buzzCount": 数, "fizzBuzzCount": 数}',
      tags: ["code"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "fizzCount", equals: 27 },
        { kind: "value", path: "buzzCount", equals: 14 },
        { kind: "value", path: "fizzBuzzCount", equals: 6 },
      ],
    },
  ],
  coder: [
    {
      id: "coder-fib20",
      title: "写一个 fib(n) 函数（fib(0)=0, fib(1)=1），计算 fib(20) 并自行运行验证。" + SUBMIT + '字段：{"value": 数值}',
      tags: ["coding"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "value", equals: 6765 },
      ],
    },
    {
      id: "coder-vowels",
      title: '写一个函数统计字符串中的元音字母（a/e/i/o/u，不区分大小写）个数，对 "hello world" 求值并自行验证。' + SUBMIT + '字段：{"vowels": 个数}',
      tags: ["coding"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "vowels", equals: 3 },
      ],
    },
    {
      id: "coder-rotate",
      title: "写一个数组右旋函数 rotate(arr, k)，对 [1,2,3,4,5,6,7] 右旋 3 位，结果用逗号拼接成字符串提交。" + SUBMIT + '字段：{"rotated": "拼接串"}',
      tags: ["coding"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "rotated", equals: "5,6,7,1,2,3,4" },
      ],
    },
    {
      id: "coder-intersect",
      title: "写一个数组交集函数，求 [1,2,3,4,5] 与 [3,4,5,6,7] 的交集，提交交集元素个数与元素之和。" + SUBMIT + '字段：{"length": 个数, "sum": 元素和}',
      tags: ["coding"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "length", equals: 3 },
        { kind: "value", path: "sum", equals: 12 },
      ],
    },
    {
      id: "coder-palindrome",
      title: '写一个回文判断函数（忽略非字母数字字符、不区分大小写），判断 "A man, a plan, a canal: Panama" 是否回文，自行验证。' + SUBMIT + '字段：{"palindrome": 是否回文}',
      tags: ["coding"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "palindrome", equals: true },
      ],
    },
  ],
  tester: [
    {
      id: "tester-leap-bug",
      title: "给定闰年函数 const isLeapYear = y => y % 4 === 0（缺百年规则——正确规格：400 整除，或 4 整除且 100 不整除）。写测试定位 bug：找到一个该函数给出错误答案的年份。" + SUBMIT + '字段：{"bugFound": 是否发现, "failingYear": 失败年份}',
      tags: ["test"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "bugFound", equals: true },
        { kind: "value", path: "failingYear", equals: 1900 },
      ],
    },
    {
      id: "tester-sort-prop",
      title: "给定排序函数 const sortAsc = a => [...a].sort((x, y) => x - y)。用伪随机（固定种子，如 xorshift32(seed=42)）生成 50 组随机数组做属性测试：结果有序 且 是输入的排列（多重集相等）。" + SUBMIT + '字段：{"allPassed": 是否全过, "cases": 用例数}',
      tags: ["test"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "allPassed", equals: true },
        { kind: "value", path: "cases", equals: 50 },
      ],
    },
    {
      id: "tester-reverse-5",
      title: '给定字符串反转函数 const rev = s => [...s].reverse().join("")。对 5 个用例（"abc"/""/"a"/"ab ba"/"12321"）做功能测试。' + SUBMIT + '字段：{"passed": 通过数, "failed": 失败数}',
      tags: ["test"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "passed", equals: 5 },
        { kind: "value", path: "failed", equals: 0 },
      ],
    },
    {
      id: "tester-abs-bug",
      title: "给定绝对值函数 const absVal = x => x > 0 ? x : x（恒返回 x——恒等 bug）。写测试定位 bug：找到一个该函数给出错误答案的输入。" + SUBMIT + '字段：{"bugFound": 是否发现, "failingInput": 失败输入}',
      tags: ["test"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "bugFound", equals: true },
        { kind: "value", path: "failingInput", equals: -3 },
      ],
    },
    {
      id: "tester-average-bug",
      title: "给定平均值函数 const average = a => a.length === 0 ? 0 : a.reduce((x,y)=>x+y,0)/a.length（规格要求：空数组应返回 null）。写边界测试定位规格违背。" + SUBMIT + '字段：{"bugFound": 是否发现}',
      tags: ["test"],
      graders: [
        { kind: "status", expect: "completed" },
        { kind: "value", path: "bugFound", equals: true },
      ],
    },
  ],
};

async function main(): Promise<void> {
  const lane = process.argv[2] ?? "all";
  if (!token) {
    console.error("PTH_TOKEN 未设置");
    process.exit(2);
  }
  const selected = lane === "all" ? Object.entries(SCENARIOS) : Object.entries(SCENARIOS).filter(([k]) => k === lane);
  if (selected.length === 0) {
    console.error(`未知 lane: ${lane}（可选 ${Object.keys(SCENARIOS).join("/")}/all）`);
    process.exit(2);
  }
  const driver = new HttpBenchDriver({ baseUrl, token, pollMs: 2000 });
  const reports = [];
  for (const [role, scenarios] of selected) {
    const withPolicy = scenarios.map((s) => ({ ...s, execPolicy: { repeats: 1, warmup: 0, concurrency: 1, timeoutMs: 480_000 } }));
    reports.push(await runSuite(driver, `dev-family-${role}`, withPolicy));
  }
  const out = reports.length === 1 ? reports[0] : reports;
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
