#!/usr/bin/env node
/**
 * adjudicate-tensions.ts —— 设计张力结构化裁决录入器（2026-08-14）
 *
 * 逐条交互录入 T1–T10 裁决（A/B/C 选项 / 自由文本 / 跳过 / 退出），
 * 结果落 docs/pth/tension-decisions.json（决策唯一数据源——agent 据此落地并回填 concepts.md §8.1）。
 *
 * 用法:
 *   npm run adjudicate                 # 逐条录入（已决条目自动跳过；s=跳过 q=保存退出）
 *   npm run adjudicate -- --redo T5    # 重新录入单条
 *   npm run adjudicate -- --check      # 只打印当前裁决状态
 * 输入协议（每条提示末尾）:
 *   A / B / C          → 选该选项
 *   A 备注文字         → 选 A 并附备注
 *   任意自由文本       → 自定义裁决（整句记录——架构级改判用它）
 *   s                  → 跳过本条（留待后议）
 *   q                  → 保存已录内容并退出
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface Option { key: string; label: string; note: string }
interface Item { id: string; title: string; conflict: string; options: Option[]; recommended: string }
interface Decision { decision?: string; note?: string; decidedAt?: string }

const OUT = "docs/pth/tension-decisions.json";

const ITEMS: Item[] = [
  {
    id: "T1", title: "worker-index 注入范围", recommended: "A",
    conflict: "worker-index 全员注入（执行族约 22 行无关清单）vs 专注度核心（0.8 核心区寸土寸金——2026-08-14 重编号后）",
    options: [
      { key: "A", label: "规划系注入 + 执行族 lazy", note: "planner/governor/controller/sensor 保留注入；执行族与信息族改 lazy 指针——与锚点先行一致，改 agent-loop 一处" },
      { key: "B", label: "全员 lazy", note: "彻底退出核心区——信息最省，但规划/裁决多一次查询往返" },
      { key: "C", label: "保持全员注入", note: "信息最完整，专注度代价维持现状" },
    ],
  },
  {
    id: "T2", title: "注入模式代码缺省", recommended: "A",
    conflict: "代码缺省 eager（无 compose 部署时全文注入）vs 锚点先行原则（默认只给锚点）",
    options: [
      { key: "A", label: "缺省改 lazy", note: "代码缺省 lazy + planner 等高频角色 eager 白名单——原则落到代码层，不靠 compose 兜底" },
      { key: "B", label: "保持 eager 缺省", note: "现状——风险在裸部署场景，原则与缺省相反" },
      { key: "C", label: "auto 按智力映射", note: "flash→lazy / pro→eager——符合 0.2 分层，但映射表需先设计，稍晚落地" },
    ],
  },
  {
    id: "T3", title: "pick_tools 动态面 vs 缓存命中率", recommended: "A",
    conflict: "pick_tools 收缩工具面保专注度 vs 工具列表变动→前缀变动→token 缓存失效",
    options: [
      { key: "A", label: "条件化启用", note: "剩余步数余量充足且任务为探索/执行型时允许；阈值走 perf-params 不硬编码" },
      { key: "B", label: "现状承认", note: "动态面随时可用，缓存牺牲计入成本——不新增判据" },
      { key: "C", label: "长前缀任务一律禁用", note: "一刀切最简单，但伤到长任务最需要收缩工具面的场景" },
    ],
  },
  {
    id: "T4", title: "JIT 自动 apply vs 人工闸门", recommended: "A",
    conflict: "0.6.1『控制量不自动生效』vs optimizer-apply 现状自动落",
    options: [
      { key: "A", label: "分层闸门", note: "可逆微调自动 apply+deopt 兜底；不可逆大变（分化/代码/删除）必须人工闸门——与 §4 原则6 一致" },
      { key: "B", label: "全人工", note: "最安全，但 JIT 内环退化为建议箱，分钟级闭环失效" },
      { key: "C", label: "全自动", note: "闭环最快，但删除/分化类失控风险高，违背 0.6.1" },
    ],
  },
  {
    id: "T5", title: "负结果收敛 N=5 vs scout 多源探测", recommended: "A",
    conflict: "同工具族+同目标连续 N=5 强制终止（死循环制动）vs scout 侦察任务合法连查多源",
    options: [
      { key: "A", label: "侦察类豁免终止", note: "scout/explorer 保留 N=3 引导、豁免 N=5 强制终止（maxSteps 兜底），按 role tags 区分——防误杀" },
      { key: "B", label: "目标判定加多样性", note: "不同查询参数/源视为不同目标——降低误判，但削弱对换汤不换药循环的制动" },
      { key: "C", label: "现状观察", note: "维持现行逻辑，出现误杀案例再调——最省事，代价是 scout 任务可能被误终止" },
    ],
  },
  {
    id: "T6", title: "空间持久化 vs 空间治理", recommended: "A",
    conflict: "0.9.2 空间持久化（重启恢复）vs 临时空间永久化→治理负担增长",
    options: [
      { key: "A", label: "三态生命周期", note: "临时（任务级 TTL 自动回收）/持久（显式标记，重启恢复）/归档（治理动作）——治理与持久化不再打架" },
      { key: "B", label: "现状+治理 v2 后补", note: "先接受增长，治理 v2 设计时一并处理——时间换复杂度" },
      { key: "C", label: "取消临时空间持久化", note: "与 0.9.2 重启恢复直接冲突，仅作对比项" },
    ],
  },
  {
    id: "T7", title: "记忆单调增长 vs 有界上下文", recommended: "A",
    conflict: "记忆库无限增长（检索质量双降）vs 0.9.4 上下文有界——sensor:memory/controller:memory 已有，缺归档执行一环",
    options: [
      { key: "A", label: "实装归档闭环", note: "manage.memory.archive 工具实装（draft→监督层批准→执行）+ 定期任务按阈值触发——删除类保持人工批准" },
      { key: "B", label: "仅手动归档命令", note: "不做定期自动，人工按需清理——省实现，治理靠人" },
      { key: "C", label: "暂缓", note: "记忆规模未到痛点先标记——但低命中条目稀释检索会先于容量疼痛" },
    ],
  },
  {
    id: "T8", title: "能力文档格式 vs 锚点标准", recommended: "A",
    conflict: "capability-index 清单式 vs 0.8.2 三要素锚点（场景锚点/何时用/效果预告）——两套标准并存",
    options: [
      { key: "A", label: "统一到锚点标准", note: "能力索引逐条改三要素，保留分节裁剪（结构与格式正交）——与术语统一合并执行" },
      { key: "B", label: "两套并存划界", note: "能力文档保持清单式（密度高），三要素仅限工具 description——继续稀释专注度" },
      { key: "C", label: "回退清单式", note: "放弃三要素，历史成本白付" },
    ],
  },
  {
    id: "T9", title: "渐进降输入 vs 任务理解质量", recommended: "A",
    conflict: "任务文本只写核心意图（渐进降输入）vs『最短指令』存在下界——核心意图必须完整到可分派",
    options: [
      { key: "A", label: "确认边界+提交侧校验", note: "正式确认为边界条件 + pth-cli/提交侧最小校验（必填字段+可路由提示）——缺意图即时反馈而非进池空转" },
      { key: "B", label: "仅文档确认", note: "不加校验，依赖提交者自觉——零成本但空转风险维持" },
      { key: "C", label: "接收侧自动补全", note: "PTH 端推测补全意图——违背最小信息原则，不可行" },
    ],
  },
  {
    id: "T10", title: "环间同对象仲裁（低优先级）", recommended: "C",
    conflict: "JIT 内环与控制环可作用于同一角色/空间，无写入仲裁",
    options: [
      { key: "A", label: "目标级写锁", note: "proposal 目标键互斥——内环快环优先，慢环冲突降级回 draft 待下轮" },
      { key: "B", label: "时间尺度声明隔离", note: "文档声明慢环裁决窗口内快环暂停 apply——实现简单但拖慢内环" },
      { key: "C", label: "暂缓观察", note: "优先级最低、无实际冲突案例——先标记，obs 观测到冲突实例后再按 A 实装" },
    ],
  },
];

function load(): Record<string, Decision> {
  if (existsSync(OUT)) {
    try { return JSON.parse(readFileSync(OUT, "utf8")) as Record<string, Decision>; }
    catch { /* 损坏则重置 */ }
  }
  return {};
}

function save(decisions: Record<string, Decision>): void {
  writeFileSync(OUT, JSON.stringify(decisions, null, 2) + "\n", "utf8");
}

function printItem(item: Item, existing?: Decision): void {
  console.log("");
  console.log("━━ " + item.id + " " + item.title + " ━━");
  console.log("张力：" + item.conflict);
  for (const o of item.options) {
    const rec = o.key === item.recommended ? "（推荐）" : "";
    console.log("  " + o.key + "  " + o.label + " " + rec);
    console.log("     " + o.note);
  }
  if (existing?.decision) {
    console.log("  当前：[" + existing.decision + "]" + (existing.note ? " " + existing.note : ""));
  }
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const redoIdx = args.indexOf("--redo");
const redo = redoIdx >= 0 ? args[redoIdx + 1] : undefined;
const decisions = load();

if (check) {
  console.log("当前裁决状态（" + OUT + "）：");
  let done = 0;
  for (const item of ITEMS) {
    const d = decisions[item.id];
    if (d?.decision) done++;
    console.log("  " + item.id + "  " + (d?.decision ? "[" + d.decision + "]" + (d.note ? " " + d.note : "") : "（未决）"));
  }
  console.log("已决 " + done + "/" + ITEMS.length);
  process.exit(0);
}

function finish(): void {
  save(decisions);
  console.log("");
  console.log("已保存 → " + OUT);
  let done = 0;
  for (const item of ITEMS) if (decisions[item.id]?.decision) done++;
  console.log("已决 " + done + "/" + ITEMS.length + "（未决条目可再次运行继续录入）");
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const queue = redo ? ITEMS.filter((i) => i.id === redo) : ITEMS;
let idx = 0;

const next = (): void => {
  if (idx >= queue.length) { finish(); return; }
  const item = queue[idx]!;
  idx++;
  if (!redo && decisions[item.id]?.decision) { next(); return; }   // 已决跳过
  printItem(item, decisions[item.id]);
  rl.question("[A/B/C 或自由文本；s=跳过 q=保存退出] > ", (raw) => {
    const t = raw.trim();
    if (t === "") { next(); return; }
    if (t.toLowerCase() === "q") { finish(); return; }
    if (t.toLowerCase() === "s") { delete decisions[item.id]; next(); return; }
    const m = t.match(/^([ABC])(?:\s+(.+))?$/i);
    if (m) {
      decisions[item.id] = { decision: m[1]!.toUpperCase(), note: m[2] ?? "", decidedAt: new Date().toISOString() };
    } else {
      decisions[item.id] = { decision: "custom", note: t, decidedAt: new Date().toISOString() };
    }
    next();
  });
};

next();

