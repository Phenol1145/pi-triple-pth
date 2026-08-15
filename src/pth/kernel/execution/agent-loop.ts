/**
 * agent-loop —— LLM agent 执行循环（PTH 初衷恢复：任务 = 意图，LLM 主导执行）。
 *
 * 循环：LLM 每步输出 JSON 动作（parse-agent-action 解析）→ 工具表执行（agent-tools）
 *   → Observation 回填 → 下一步；done 终止；maxSteps/超时强制终止。
 *
 * 复用：llm-fn（ModelRuntime——与 PTL/PTH provider 同源）、kernel 三件套（REPL 工具）、
 *   capability 白名单（web/state/fs/memory——与 vm 注入同一份）。
 * 自研原因（spike 结论 2026-08-08）：SDK createAgentSession 的 system prompt 不可定制
 *   （prompt 时重建）且加载本环境扩展（place_bid 等）——任务执行需要受控环境。
 */
import type { LlmFn } from "../interpreter/llm-fn.js";
import type { WorkerKernel } from "../interpreter/index.js";
import type { WorkerRole } from "./worker-cluster.js";
import { AGENT_TOOLS, AGENT_CAPABILITY_DOC, toolsToSchema, toolsDescription, toolsForExecTool, toolSchemaFor, expandToolGroups, type AgentToolResult } from "./agent-tools.js";
import { parseAgentAction, AGENT_CAPABILITY_AS_ACTION } from "./parse-agent-action.js";
import { config, configNumber } from "../extensions/perf-params.js";
import { createGuardRegistry } from "./guardrails.js";
import { runPtcProgram } from "../ptc/runner.js";
import { modelState } from "../extensions/model.js";
import { spaceRegistry, isRoleBoundToSpace } from "./space-registry.js";

/** 执行面角色授权（2026-08-12 审计 HIGH-2 修复）：语言/生产工具需对应 capability——
 *  capabilities 声明了但未含所需 → 拒绝（未声明 = 全量兼容；ts 族为基础执行面不校验） */
const EXEC_TOOL_CAP: Record<string, string[]> = {
  python: ["python"], bash: ["bash"],
  dev: ["c", "dev", "python", "bash"],   // dev.run/list 只读——验收角色（python/bash）可用
  write: ["fs", "write"],
};

/** ASP 模式工具面（按当前空间动态计算——环境函数全空间可用，语言工具仅本空间，done 仅元空间）
 *  actionTools 白名单过滤（2026-08-12 审计 HIGH-2 修复）：角色声明了 actionTools →
 *  schema 面按其过滤（与 prompt 文本描述一致）；未声明 = 全量兼容（用户裁决）。 */
function toolsForSpace(spaceId: string, actionTools?: string[]): import("@earendil-works/pi-ai").Tool[] {
  const allowed = actionTools ? new Set(expandToolGroups(actionTools)) : null;
  const ok = (t: import("@earendil-works/pi-ai").Tool | null): t is import("@earendil-works/pi-ai").Tool =>
    t !== null && (allowed === null || allowed.has(t.name.replace(/_/g, ".")));
  const ambient = [toolSchemaFor("asp.cd"), toolSchemaFor("asp.index"),
    toolSchemaFor("memory.index"),
    toolSchemaFor("cache.load"), toolSchemaFor("cache.index"), toolSchemaFor("cache.cancel")].filter(ok);   // 2026-08-14 N8：asp.create/destroy 已退役（生成走治理通道）
  if (spaceId === "meta") return [...ambient, toolSchemaFor("done")!];
  const sp = spaceRegistry.get(spaceId);
  if (sp?.execTool) {
    // extraTools 族展开（2026-08-11 生产核——dev 空间 = dev 族 + debug 族）
    const execs = [...toolsForExecTool(sp.execTool), ...(sp.extraTools ?? []).flatMap((t) => toolsForExecTool(t))].filter(ok);
    if (execs.length > 0) return [...ambient, ...execs];
  }
  return ambient;
}

/** ASP 模式 system prompt 附加块（协议世界观——空间/迁移/完成规则；
 *  2026-08-14 N8 修订：空间从「先验基板」到「派生结构」——基板全角色共享，绑定空间仅绑定类型可进；
 *  空间由系统随 worker 分化/注意力管理生成——worker 不创建/注销空间（生成走优化通道+审批面）） */
const ASP_BLOCK = "【动作空间协议（ASP）】\n你在【元空间】开始——元空间无执行核，语言代码不可在此解析。\n- 探索：asp_index() 查看你可进入的空间（语言执行基板 ts/python/bash/dev/write 全角色共享；绑定空间仅绑定 worker 类型可进入——索引会标注）\n- 执行：asp_cd 切换——asp_cd(\"ts\")（ts 程序空间——能力包 memory/llm/web/fs/state 等）/ asp_cd(\"python\") / asp_cd(\"bash\")；产物生产：asp_cd(\"dev\")（代码——dev.*/debug.*）/ asp_cd(\"write\")（文档——write.*）\n- 空间数据是本地的：ts 里声明的变量在 python 空间不可见（跨空间携带信息用记忆/缓存工具）\n- 空间由系统生成（随 worker 分化/注意力管理需要）——你不需要也不可创建/注销空间\n- 完成任务：asp_cd(\"meta\") 回到元空间 → done 提交（done 仅在元空间可用）";

export interface AgentTaskInput {
  task: { title: string; text: string };
  /** 任务工作区（fs.task 落盘——ts 工具 cwd） */
  taskWorkspace?: string;
  /** 产物单元存储（生产核 dev.save/dev.list——batch-process 透传） */
  toolstore?: import("../interpreter/toolstore.js").Toolstore;
  role?: WorkerRole;
}

export interface AgentLoopOptions {
  llm: LlmFn;
  kernel: WorkerKernel;
  /** capability 白名单（web/state/fs/memory）——与 vm 注入同一份 */
  caps: Record<string, unknown>;
  maxSteps?: number;
  timeoutMs?: number;
  logger?: (msg: string) => void;
  onStep?: (step: { n: number; tool: string; durationMs: number; ok: boolean; args?: string }) => void;
  /** 运行过程保留（2026-08-09）：轨迹事件流——task-loop 收集写 transcript（审计/复现/续跑） */
  onTrace?: (event: AgentTraceEvent) => void;
  /** ASP 模式（动作空间协议——2026-08-10）：当前空间状态机（初始元空间——语言工具门控/done 仅元空间）。
   *  ASP 状态机：compose 默认 PTH_ASP_MODE=on（全件落地——2026-08-11）；测试按需显式 asp:true/off */
  asp?: boolean;
  /** ASP 会话空间引用（kernel.sessionRef——memory 可见性盖章/过滤读取同一状态） */
  sessionRef?: { current: { currentSpace: string } | null };
  /** 随身缓存（任务级——task-loop 注入并与 vm cache 对象同源；缺省 loop 自建） */
  cache?: import("./cache-store.js").CacheStore;
  /** 任务级能力装配（Phase 3 条目 12——cache 收敛）：透传 runner caps
   *  （task-loop 构建——每 ts 程序执行前统一注入 vm；与越界预检同一机制） */
  capabilityInject?: Record<string, unknown>;
}

/** 运行过程轨迹事件（结构化——transcript body 事件数组） */
export type AgentTraceEvent =
  | { type: "llm-call"; step: number; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; contentPreview: string; thinking?: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
  | { type: "tool-call"; step: number; tool: string; args: Record<string, unknown> }
  | { type: "tool-result"; step: number; tool: string; ok: boolean; durationMs: number; resultPreview: string }
  | { type: "guard"; step: number; guard: "repeat-action" | "empty-done" | "empty-reply" | "unknown-tool" | "negative-loop"; kind: "hit" | "guide" | "soft" | "hard"; count: number; limit: number }
  | { type: "finish"; ok: boolean; steps: number; error?: string; warning?: string; valuePreview?: string };

export type AgentTaskResult =
  | { ok: true; value: unknown; summary?: string; steps: number; warning?: string; compression?: import("./context-compaction.js").CompactionResult | null }
  | { ok: false; error: string; steps: number; compression?: import("./context-compaction.js").CompactionResult | null };

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_TIMEOUT_MS = 120_000;

/** 构建 agent system prompt：角色人设 + 工具协议 + 能力文档 + PTC 程序模式引导 + 输出要求 */
/** PTH Worker 世界观（2026-08-09——参考 pi 系统提示词/AGENTS.md 功能：身份/工作流/框架事实/约束）。
 * 固定注入（所有角色共享——buildAgentSystemPrompt 最前）——worker 知道自己在 PTH 框架。
 * 详细规则文档化（memory kind='pth-worker-system'——受保护——lazy 可查）。 */
export const PTH_WORKER_SYSTEM = `【PTH Worker 世界观】（你在哪/怎么工作）
你是 PTH（Pi-Triple-Heavy）任务池的 worker——处理任务池分配的【单个任务】。
PTH = 服务器端任务内核：任务池 → 角色路由 → worker 执行 → 产物提交 → 应用。

工作流：任务 → 理解（评估需要什么）→ 按需探索（先查 memory 既有资产 → 能力索引 → 源码）
→ 执行（PTC ts 程序组合能力）→ 产物（fs.task 写 / 结果对象）→ done 提交（result 必带产物）

框架事实：
- 记忆（memory）：PTH 共享知识层——先 query 查已有沉淀（task-insight/tool-function）——有价值洞察 write 沉淀
- 角色：内置角色正交分工——查你的角色文档：
  const r = await memory.query("SELECT content FROM memory_entries WHERE id='role-doc:你的角色id' LIMIT 1")
- 产物：fs.task 写任务工作区 → 归档 → 人工/系统应用
- 改系统：fs.readSource 读源码 + 遵循 self-modify-guide

约束：
- 完成标准：有实际产物（实现/文件/结果）——不空 done
- 推进纪律：理解够即转实现——不无限探索
- 探索顺序：先 memory 既有资产 → 能力索引 → 源码（不重复查）
- sandbox 零敏感 · 扩展代码库式 · 权限注入面收窄 · 任务正交路由`;

/** Prompt 框架（2026-08-09：Prompt 文档化——统一模板 + eager/lazy 渲染参数）。
 * 数据源：memory（role-doc:<role> / capability-index——injectPromptDocs 注入）。
 * eager：渲染层 query 读全文注入；lazy：指针（LLM 按需 memory.query——与 memory 检索同构）。
 * 新核/新角色：更新 memory 文档——模板零改动。 */
/**
 * 能力文档按角色 capabilities 裁剪（Agent-JIT 路径 B——2026-08-11）。
 * 分节约定（capability-index 条目）：## 基础（全角色）/ ## memory / ## fs /
 * ## 执行核 / ## web/llm/state/ext/env。包映射：memory→memory；fs→fs；
 * python/bash/c→执行核；web/llm/state/ext/env/skills/obs→扩展面。
 * 无匹配节时保留原文（向后兼容自由格式文档）。
 */
export function filterCapabilityDoc(doc: string, capabilities: string[]): string {
  // 按 ## 节切分（保留节头）
  const parts = doc.split(/(?=^## )/m);
  const header = parts[0] ?? doc;   // 文档头（标题/说明）
  const sections = parts.slice(1);
  const keep: string[] = [];
  const caps = new Set(capabilities);
  let matchedAny = false;
  for (const sec of sections) {
    const title = sec.split(/\n/, 1)[0] ?? "";
    if (title.startsWith("## 基础")) { keep.push(sec); continue; }   // 全角色
    const matched = (title.includes("memory") && caps.has("memory"))
      || (title.includes("fs") && (caps.has("fs") || caps.has("readSource") || caps.has("readText")))
      || (title.includes("执行核") && (caps.has("python") || caps.has("bash") || caps.has("c")))
      || (caps.has("web") || caps.has("llm") || caps.has("state") || caps.has("ext") || caps.has("env") || caps.has("skills") || caps.has("obs")) && title.includes("web/llm");
    if (matched) { keep.push(sec); matchedAny = true; }
  }
  if (!matchedAny) return doc;   // 无匹配（自由格式/新包）——原文
  return `${header}${keep.join("")}`;
}

export async function buildAgentSystemPrompt(
  role: WorkerRole | undefined,
  taskTitle: string,
  opts: { mode?: "eager" | "lazy" | "auto"; memory?: { query(sql: string): Promise<Array<{ content: string }>> } } = {},
): Promise<string> {
  const { renderWorkerIndex, isPlanningRole } = await import("./worker-cluster.js");
  // 模式（2026-08-14 T2 裁决）：env 显式覆盖 > 角色类缺省——规划系 eager（高频稳定、缓存价值高），
  // 执行族/信息族 lazy（锚点先行——代码缺省不再 eager）；auto 按模型智力映射留待后续
  const planningRole = isPlanningRole(role?.id);
  const mode = opts.mode ?? (process.env.PTH_AGENT_MODE === "eager" ? "eager" : process.env.PTH_AGENT_MODE === "lazy" ? "lazy" : (planningRole ? "eager" : "lazy"));

  // 角色块：eager = 角色文档全文（memory query）；lazy = 指针
  let roleBlock = "";
  if (role) {
    if (mode === "lazy") {
      roleBlock = `你的角色：${role.id}。角色文档在 memory（id='role-doc:${role.id}'）——
先用 memory.query 查询它了解你的职责与工作方式：
SELECT content FROM memory_entries WHERE id='role-doc:${role.id}' LIMIT 1\n（若查询不到——按人设执行：${role.prompt.slice(0, 120)}）`;
    } else {
      try {
        const rows = opts.memory ? await opts.memory.query(`SELECT content FROM memory_entries WHERE id='role-doc:${role.id}' LIMIT 1`) : [];
        roleBlock = rows[0]?.content ?? role.prompt;
      } catch {
        roleBlock = role.prompt;
      }
    }
  }

  // 能力块：eager = 能力索引全文；lazy = 指针
  let capBlock = "";
  if (mode === "lazy") {
    capBlock = `【能力探索（按需读取）】
ts 程序内可调用能力函数——完整清单在 memory（kind='capability-index'）：
const idx = await memory.query("SELECT content FROM memory_entries WHERE kind='capability-index' LIMIT 1");\n（或用 fs.readText 读 toolstore 文件）——需要什么能力先查索引——不要盲试。
代码库结构（找文件/模块在哪/哪个文件做什么）——查 project-map：
const pm = await memory.query("SELECT content FROM memory_entries WHERE kind='project-map' LIMIT 1");
源码阅读：fs.readSource（读索引可知用法）。任务工作区写入：fs.task（读索引可知）。`;
  } else {
    try {
      const rows = opts.memory ? await opts.memory.query("SELECT content FROM memory_entries WHERE kind='capability-index' LIMIT 1") : [];
      capBlock = rows[0]?.content ?? AGENT_CAPABILITY_DOC;
      // Agent-JIT 路径 B：能力文档按角色 capabilities 裁剪（按包分节——## 包名——
      // 只注入相关节 + 基础节；无 capabilities 声明（全量）→ 原文）。
      if (role?.capabilities) capBlock = filterCapabilityDoc(capBlock, role.capabilities);
    } catch {
      capBlock = AGENT_CAPABILITY_DOC;
    }
  }

  // worker-index 块（2026-08-14 T1 裁决：规划系注入全文；执行族/信息族 lazy 指针——锚点先行）
  let workerIndexBlock = "";
  try {
    if (planningRole) {
      workerIndexBlock = `\n${renderWorkerIndex()}\n`;
    } else {
      workerIndexBlock = "\n可派发角色清单（worker-index）：需要路由/协作时用 memory.query 查询（kind='worker-index'）——不常驻上下文（锚点先行——2026-08-14 T1）。\n";
    }
  } catch { /* 渲染失败降级——不影响启动 */ }

  // 推理预算块（role.thinking 从声明到作用——2026-08-10 PTH worker 实现）：角色声明推理深度 → system prompt 生效
  let thinkingBlock = "";
  if (role?.thinking) {
    const budget: Record<"high" | "medium" | "low", string> = {
      high: "本次任务推理预算：深度推理——多步验证、权衡备选方案、明确不确定点。",
      medium: "本次任务推理预算：适中——完成目标所需的最小推理深度。",
      low: "本次任务推理预算：浅——快速行动，避免过度分析（scout 类快速侦察角色）。",
    };
    const line = budget[role.thinking] ?? "";
    if (line) thinkingBlock = `\n${line}\n`;
  }

  // 探索核候选块（backlog 差距 11——2026-08-12）：角色显式声明可用语言核集合时注入——
  // A/B 并存引导：探索性任务可分别用不同语言核验证同一问题（探索空间按语言划分）。
  let exploreBlock = "";
  if (role?.exploreKernels && role.exploreKernels.length > 0) {
    const langs = role.exploreKernels.join("/");
    exploreBlock = `\n【探索核候选】本角色声明可用执行语言：${langs}。探索性/验证性任务可分别用不同语言核验证同一问题（A/B 并存——对比结果一致性）；各语言核的探索空间相互隔离（asp.cd(\"python\")/asp.cd(\"bash\") 按语言划分）。\n`;
  }

  return `${PTH_WORKER_SYSTEM}

当前任务：${taskTitle}

${roleBlock}
${workerIndexBlock}
${thinkingBlock}
${exploreBlock}
${toolsDescription(role?.actionTools)}

${capBlock}

【API 调查技能】（当你不清楚执行核预定义函数/对象（fs/memory/llm/context 等）的构成、参数、语法或返回值时）
const skill = await memory.query("SELECT content FROM memory_entries WHERE id='skill:api-investigation' LIMIT 1");
（按文档方法调查——Object.keys/fn.toString/读实现源码/试错推断——不要盲试）

【程序模式（PTC——优先使用）】
优先用 ts.run 写【完整程序】一次性组合多个 kernel/能力完成多步，而不是分步发多个动作；
单行查询/计算（不需要变量/循环）用 ts.eval 直接求值：
- ts 程序运行在 vm 沙箱，可 await 调用能力函数；程序内可写 for/if/函数/变量——跨步骤传值
- 结果自动注册 results 对象（results.result_1 引用之前步骤的工具输出）
- context 对象跨步骤保留（context.my_key = ... 供后续程序读取）
- return 的值 + 程序 stdout 都会回填给你（中间输出可见）
单 kernel 简单步骤（python.run/bash.run）可直接调用；单表达式求值用 ts.eval/python.eval；复杂多步组合用 ts.run。

输出要求：每步输出一个 JSON 动作（可用工具在 tools 声明中——结构化 tool_calls）。
完成任务时输出 done 工具：
  - args.result = 最终产出对象（【必填】——实际结果/实现代码/文件清单/测试输出——不能为空）
  - args.summary = 完成说明
完成标准（满足其一即完成）：
  ① 有实际产物（实现/文件写入/计算结果）——result 带产物
  ② 明确无法完成（信息不足/超出能力/环境限制）——done 提交并说明原因（summary 详细）
未达完成标准不要 done——继续推进（实现/测试/沉淀）。`;
}

function isTsFamily(tool: string): boolean {
  return tool.replace(/_/g, ".") === "ts.run" || tool.replace(/_/g, ".") === "ts.eval";
}

function truncate(s: string, max = 2000): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + `…(截断 ${s.length - max} 字符)`, truncated: true };
}

/** 动作指纹（防死锁/重复：连续相同动作检测）
 * 归一化（轨迹分析 2026-08-09——两轮修正）：
 *   ① readSource/readText：同路径 = 重复（模型 14 次微变重写同一 readSource——全量 args
 *      比较被变量名/注释差异绕过——按文件路径判定）
 *   ② memory 查询：同 SQL = 重复（c473e646 实测：无文件读取的 ts 退化 `ts:*` 把不同查询
 *      （role/索引/列表）误判重复——按 SQL 指纹区分）
 *   ③ 其他 ts：code 去空白归一化（微变仍算不同——防误判） */
function actionFingerprint(tool: string, args: Record<string, unknown>): string {
  if (isTsFamily(tool) && typeof args.code === "string") {
    const code = args.code;
    const reads = [...code.matchAll(/fs\.(readSource|readText)\(\s*"([^"]+)"/g)]
      .map((m) => `${m[1]}:${m[2]}`)
      .sort();
    if (reads.length > 0) return `ts:${reads.join(",")}`;
    const memSqls = [...code.matchAll(/memory\.query\(\s*"([^"]+)"/g)]
      .map((m) => m[1])
      .sort();
    if (memSqls.length > 0) return `ts:mem:${memSqls.join("|")}`;
    return `ts:${code.replace(/\s+/g, " ").slice(0, 200)}`;
  }
  return `${tool}:${JSON.stringify(args)}`;
}
// ── 负结果收敛窗口（S6 死循环机制落地——controller 裁决 2026-08-13）──────────
// 证据：agent-reach 279 步 maxSteps 强制终止，bash_run=174 反复探测 extensions/<name>/index.ts
//       （参数微变绕过参数指纹——同目标不同参数的负验证循环无收敛条件）
// 机制：recentResults 窗口（下限 6 步，随终止阈值动态扩展）按"同工具族+同目标+连续 N 次负结果"判定，
//       N=3 回填引导（该路径已确认不可用→换策略）、N=15 强制终止
//       （2026-08-15 D2 裁决：5→15 放宽——给 sensor 留观测窗口；失败任务尚无正常回收机制，
//       过早强制闭合过于严苛）——与参数指纹并存。
// 窗口下限 6（原 S6 设计）；运行时按 negativeLimits().terminate + 1 动态扩展——
// 阈值可配置（2026-08-15 D2 缺省 15），窗口必须 ≥ 阈值，否则计数永远到不了终止线。
const RECENT_RESULTS_WINDOW = 6;
// 负结果收敛阈值（N12 护栏统一抽象——配置键 PTH_GUARD_NEGATIVE_LIMIT / PTH_GUARD_NEGATIVE_GUIDE_AT，
// 缺省 15/3——经 guardReg.negativeLimits() 解析后传入 negativeLoopCheck）
const NEG_SEMANTICS = [
  /not found/i, /no such (file|directory)/i, /ENOENT/i, /cannot find/i,
  /不存在/i, /未找到/i, /无此/i, /无法找到/i,
  /failed/i, /failure/i, /失败/i, /\berror\b/i, /错误/i,
  /reject/i, /拒绝/i, /denied/i, /越权/i, /无权/i,
  /不可用/i, /unavailable/i, /invalid/i, /missing/i,
];
interface RecentAction { family: string; target: string; neg: boolean; }

/** 工具族归一（bash_run/bash_eval→bash；ts_run/ts_eval→ts；fs.*→fs）——负结果按族聚合 */
function toolFamily(tool: string): string {
  const t = tool.replace(/_/g, ".");
  for (const fam of ["bash", "python", "ts", "fs", "memory", "dev", "debug", "write", "cache"]) {
    if (t === fam || t.startsWith(fam + ".")) return fam;
  }
  return t.split(".")[0];
}

/** 路径模式化：具体文件名/段 → *（保留扩展名与结构）——"同目标不同参数"归一 */
function normalizePathPattern(p: string): string {
  const segs = p.split("/");
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s || s === "." || s === "..") continue;
    if (/^[A-Za-z0-9_.-]+$/.test(s)) {
      const ext = s.match(/\.([A-Za-z0-9]+)$/);
      segs[i] = ext ? `*.${ext[1]}` : "*";
    }
  }
  return segs.join("/");
}

/** 动作目标提取（语义维度——补参数指纹盲区：同目标不同参数的负验证循环） */
function actionTarget(tool: string, args: Record<string, unknown>): string {
  const t = tool.replace(/_/g, ".");
  if (typeof args.code === "string") {
    const code = args.code;
    const reads = [...code.matchAll(/fs\.(?:readSource|readText)\(\s*"([^"]+)"/g)].map((m) => m[1]);
    if (reads.length > 0) return `file:${reads.map(normalizePathPattern).sort().join("|")}`;
    const mems = [...code.matchAll(/memory\.query\(\s*"([^"]+)"/g)].map((m) => m[1]);
    if (mems.length > 0) return `mem:${mems.map((s) => s.replace(/[0-9a-fA-F]{8,}/g, "*id*").replace(/\s+/g, " ").slice(0, 80)).sort().join("|")}`;
    return `code:${code.replace(/\s+/g, " ").slice(0, 100)}`;
  }
  const cmd = String(args.command ?? args.cmd ?? "");
  if (cmd) {
    const paths = cmd.match(/[\w./-]+\.(?:ts|js|json|md|txt|py|sh|c|h|yaml|yml)/g) ?? [];
    if (paths.length > 0) return `path:${paths.map(normalizePathPattern).sort().join("|")}`;
    return `cmd:${cmd.replace(/\s+/g, " ").slice(0, 100)}`;
  }
  const pathArg = String(args.path ?? args.relPath ?? "");
  if (pathArg) return `file:${normalizePathPattern(pathArg)}`;
  const sqlArg = String(args.sql ?? "");
  if (sqlArg) return `mem:${sqlArg.replace(/[0-9a-fA-F]{8,}/g, "*id*").replace(/\s+/g, " ").slice(0, 80)}`;
  return `${t}:${JSON.stringify(args).slice(0, 120)}`;
}

/** 负结果语义判定：工具级失败（ok=false）或输出含失败语义（NOT FOUND 等——bash 退出码 0 盲区） */
function isNegativeResult(result: { ok?: boolean; error?: unknown; stdout?: unknown; value?: unknown } | undefined | null): boolean {
  if (!result) return true;
  if (result.ok === false) return true;
  const text = `${result.error ?? ""} ${result.stdout ?? ""} ${typeof result.value === "string" ? result.value : JSON.stringify(result.value ?? "")}`;
  return NEG_SEMANTICS.some((p) => p.test(text));
}

/** 负结果收敛检查：窗口内同 family+target 的连续负结果计数 → 引导/终止。
 *  阈值走护栏注册表（N12——PTH_GUARD_NEGATIVE_LIMIT/GUIDE_AT，运行时可调）；
 *  allowTerminate=false = 豁免矩阵命中（T5 侦察豁免——guardReg.exempt 判定）。 */
function negativeLoopCheck(win: RecentAction[], family: string, target: string, neg: boolean, allowTerminate = true, terminateAt = 15, guideAt = 3): { action: "none" | "guide" | "terminate"; count: number } {
  if (!neg) return { action: "none", count: 0 };
  let count = 0;
  for (let i = win.length - 1; i >= 0; i--) {
    const r = win[i];
    if (r.family !== family || r.target !== target) continue;  // 不同目标/工具族不影响该目标计数
    if (!r.neg) break;                                          // 同目标正结果中断连续
    count++;
  }
  if (allowTerminate && count >= terminateAt) return { action: "terminate", count };
  if (count >= guideAt) return { action: "guide", count };
  return { action: "none", count };
}
/** 静态环境注入：toolstore 文件清单 + 记忆概览（失败容忍——不阻断任务） */
async function buildEnvironmentPrelude(caps: Record<string, unknown>): Promise<string> {
  const parts: string[] = [];
  try {
    const fs = caps["fs"] as { list?(dir?: string): Promise<unknown> } | undefined;
    if (fs?.list) {
      const files = await fs.list();
      const text = JSON.stringify(files);
      if (text && text !== "[]") parts.push(`toolstore 文件: ${text.slice(0, 1000)}`);
    }
  } catch { /* 无 toolstore 容忍 */ }
  try {
    const memory = caps["memory"] as { query?(sql: string): Promise<unknown> } | undefined;
    if (memory?.query) {
      const rows = await memory.query("SELECT kind, count(*) AS n FROM memory_entries GROUP BY kind ORDER BY n DESC LIMIT 10");
      const text = JSON.stringify(rows);
      if (text && text !== "[]") parts.push(`记忆概览: ${text.slice(0, 1000)}`);
    }
  } catch { /* 记忆不可用容忍 */ }
  return parts.join("\n");
}

/** 内核（原 runAgentTask 循环体——压缩包装器包在外层） */
async function runAgentTaskCore(input: AgentTaskInput & AgentLoopOptions): Promise<AgentTaskResult> {
  const { llm, kernel, caps } = input;
  // 参数走配置中心（Phase 2——perf.set 运行时生效；env 兜底）
  const maxSteps = input.maxSteps ?? configNumber("PTH_AGENT_MAX_STEPS", DEFAULT_MAX_STEPS);
  const timeoutMs = input.timeoutMs ?? configNumber("PTH_AGENT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  // ASP 模式（动作空间协议——过渡期旗标）：当前空间状态机
  const aspMode = input.asp === true;
  const aspSession = { currentSpace: "meta" };   // ASP：初始驻地 = 元空间
  if (input.sessionRef) input.sessionRef.current = aspSession;   // memory 可见性读取同一会话
  const currentSpace = () => aspSession.currentSpace;
  // 随身缓存（任务级行李——task-loop 注入或本函数自建）
  const cache: import("./cache-store.js").CacheStore = input.cache ?? new (await import("./cache-store.js")).CacheStore();
  let system = await buildAgentSystemPrompt(input.role, input.task.title, {
    // 2026-08-14 T2：仅显式 env 覆盖才传入——缺省交由角色类策略（规划系 eager/其余 lazy）
    mode: (process.env.PTH_AGENT_MODE === "lazy" || process.env.PTH_AGENT_MODE === "eager" ? process.env.PTH_AGENT_MODE : undefined) as "eager" | "lazy" | undefined,
    memory: (caps as { memory?: { query(sql: string): Promise<Array<{ content: string }>> } }).memory,
  });
  if (aspMode) system = `${system}\n\n${ASP_BLOCK}`;
  // 静态环境注入（②）：任务开始时拉环境预置（toolstore 文件 + 记忆概览）——LLM 一上来就知道可用资产
  const prelude = await buildEnvironmentPrelude(caps);

  // 消息策略（2026-08-09 架构修正——用户裁决：OpenAI 格式 API 用原生 tool_calls，
  // 不是文本 JSON 动作解析）：
  //   多轮消息：assistant 回复（含 ToolCall 意图）→ 执行 → toolResult 回填（toolCallId 关联）→
  //   模型在结构化工具调用与文本回复间二选一——不存在"输出大段代码导致 parse 失败"。
  //   单轮模式（旧——文本 JSON 动作）废弃；parseAgentAction 保留为 done 文本降级兼容。
  const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string; toolName?: string; thinking?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }> = [
    { role: "system", content: system },
    { role: "user", content: `任务描述：${input.task.text}\n\n${prelude ? `环境预置：\n${prelude}\n\n` : ""}` },
  ];
  (input as { __messages?: unknown }).__messages = messages;   // 压缩包装器读取（同一引用——循环内持续 push）
  const staticTools = toolsToSchema(input.role?.actionTools);

  // ── 工具面（2026-08-14 T3 裁决：废弃 pick_tools 动态注入——结构化动作空间+记忆空间
  //    已减少同时暴露的工具数；工具面 = 空间面 ∩ 角色白名单，不再动态收窄）──
  /** 当前轮 LLM 调用实际工具面 */
  function currentTools(aspCurrent: string): import("@earendil-works/pi-ai").Tool[] {
    const base = aspMode
      ? toolsForSpace(aspCurrent, input.role?.actionTools)
      : [...staticTools];
    // 同名工具去重（OpenAI 对重复工具名 400）
    return [...new Map(base.map((t) => [t.name, t])).values()];
  }

  const start = Date.now();
  let steps = 0;
  let lastFingerprint = "";
  let recentResults: RecentAction[] = [];  // 负结果收敛窗口（≤6 步——同工具族+同目标连续负结果 N=3 引导/N=15 终止——S6 死循环机制 2026-08-13；N=15 由 2026-08-15 D2 裁决）
  // 护栏注册表（2026-08-14 N12——阈值 PTH_GUARD_* 走配置中心、豁免矩阵声明式、处置语义统一 soft/hard）
  const guardReg = createGuardRegistry((k, d) => configNumber(k, d));
  const repeatGuard = guardReg.guard("repeat-action");
  const emptyDoneGuard = guardReg.guard("empty-done");
  const emptyReplyGuard = guardReg.guard("empty-reply");
  const unknownToolGuard = guardReg.guard("unknown-tool");

  const complete = async (tools: import("@earendil-works/pi-ai").Tool[]): Promise<import("../interpreter/llm-fn.js").LlmResult | string> => {
    try {
      // LLM 调用超时保护（实测修复 2026-08-09：deepseek-v4-flash 挂起 → 循环冻结——
      // 任务级超时检查在循环头，卡在 await 内永远到不了；单次调用 30s 兜底）
      const llmTimeoutMs = configNumber("PTH_AGENT_LLM_TIMEOUT_MS", 30_000);
      return await Promise.race([
        llm.complete(
          messages,
          {
            provider: "deepseek",
            model: input.role?.model ?? modelState.current?.model ?? config().get("PTH_AGENT_MODEL") ?? "deepseek-v4-flash",
            thinking: input.role?.thinking,   // Agent-JIT 路径 B：角色推理档 → reasoning_effort（scout low / 执行 high）
            timeoutMs: llmTimeoutMs,
            tools,
          },
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`llm-timeout after ${llmTimeoutMs}ms`)), llmTimeoutMs)),
      ]);
    } catch (e) {
      return `__llm_error__:${(e as Error).message}`;
    }
  };

  for (; steps < maxSteps; steps++) {
    if (Date.now() - start > timeoutMs) {
      return { ok: false, error: `agent-timeout: 超过 ${timeoutMs}ms`, steps };
    }

    // ASP：工具面随当前空间动态计算（语言工具仅本空间可调用）
    const tools = currentTools(currentSpace());
    const res = await complete(tools);
    if (typeof res === "string") {
      if (res.startsWith("__llm_error__")) {
        input.onTrace?.({ type: "finish", ok: false, steps: steps + 1, error: res.slice(14) });
        return { ok: false, error: res.slice(14), steps };
      }
      // LLM 直接文本回复（无工具调用）——视为完成（内容作为结果说明）
      return { ok: true, value: res || null, summary: res, steps: steps + 1 };
    }
    messages.push({ role: "assistant", content: res.content, ...(res.thinking ? { thinking: res.thinking } : {}), ...(res.toolCalls && res.toolCalls.length > 0 ? { toolCalls: res.toolCalls } : {}) });
    input.onTrace?.({ type: "llm-call", step: steps + 1, toolCalls: res.toolCalls, contentPreview: (res.content ?? "").slice(0, 500), ...((res as { thinking?: string }).thinking ? { thinking: (res as { thinking?: string }).thinking!.slice(0, 800) } : {}), ...(res.usage ? { usage: res.usage } : {}) });
    // 2026-08-15 审计 MEDIUM-2：空回复护栏只在"真空回复"时 hit——有工具调用/有文本就重置
    if ((res.toolCalls && res.toolCalls.length > 0) || (res.content && res.content.trim().length > 0)) {
      emptyReplyGuard.step({ roleId: input.role?.id, tool: "(empty-reply)", steps: steps + 1 }, false);
    }

    // 原生 tool_calls：结构化调用（OpenAI 格式——非文本解析）
    if (res.toolCalls && res.toolCalls.length > 0) {
      for (const tc of res.toolCalls) {
        const r = await executeStep({ tool: tc.name, args: tc.arguments, thought: undefined }, tc.id);
        if (r !== undefined) {
          // 序列完整性（2026-08-14 B1）：提前终止时，未回填的调用补合成 tool 消息——
          // 防止 assistant(tool_calls) 悬挂（DeepSeek v4 校验每个 tool_calls 必须有对应 tool 响应）
          for (const rest of res.toolCalls) {
            const key = rest.id ?? `tc-${steps + 1}`;
            if (!messages.some((m) => m.role === "tool" && m.toolCallId === key)) {
              messages.push({ role: "tool", toolCallId: key, toolName: rest.name, content: "[终止] 任务已提前结束——该调用未执行。" });
            }
          }
          return r;
        }
      }
      continue;
    }
    // 无工具调用但 assistant 有文本——完成
    if (res.content && res.content.trim().length > 0) {
      return { ok: true, value: res.content, summary: res.content, steps: steps + 1 };
    }
    // 空回复（deepseek-v4-flash 已知问题）——重试而非完成（连续 N 次判失败——N12 护栏）
    const ev = emptyReplyGuard.step({ roleId: input.role?.id, tool: "(empty-reply)", steps: steps + 1 }, true);
    if (ev.kind !== "none") input.onTrace?.({ type: "guard", step: steps + 1, guard: "empty-reply", kind: ev.kind, count: ev.count, limit: ev.limit });
    if (ev.kind === "hard") return { ok: false, error: "llm 连续空回复（无 tool_calls 无文本）", steps: steps + 1 };
    continue;
  }

  input.onTrace?.({ type: "finish", ok: true, steps, warning: `达到 maxSteps(${maxSteps}) 强制终止` });
  return { ok: true, value: null, steps, warning: `达到 maxSteps(${maxSteps}) 强制终止` };

  async function executeStep(action: { tool: string; args: Record<string, unknown>; thought?: string }, toolCallId?: string): Promise<AgentTaskResult | undefined> {
    const { tool } = action;
    // 2026-08-15 审计 MEDIUM-4：provider 可能给 null/数组/字符串 arguments——统一对象化再分发
    const args: Record<string, unknown> =
      action.args && typeof action.args === "object" && !Array.isArray(action.args) ? action.args : {};
    // 重复检测（收敛 agent 行为 v1——轨迹分析 2026-08-09）：
    // 语义指纹（关键参数）连续相同 → 重复。≥3 次回填引导（不终止——模型修正策略）；
    // ≥5 次强制终止（防失控）。
    const fp = actionFingerprint(tool, args);
    const fpHit = fp === lastFingerprint;
    if (!fpHit) lastFingerprint = fp;
    const rv = repeatGuard.step({ roleId: input.role?.id, tool, steps: steps + 1 }, fpHit);
    if (rv.kind !== "none") input.onTrace?.({ type: "guard", step: steps + 1, guard: "repeat-action", kind: rv.kind, count: rv.count, limit: rv.limit });
    if (rv.kind === "soft") {
      return { ok: true, value: null, steps: steps + 1, warning: `连续 ${rv.count} 次重复动作（${tool}），强制终止` };
    }
    if (rv.kind === "guide" && isTsFamily(tool)) {
      // 引导：重复读同一文件无意义——回填提示让模型推进（结果已在历史 tool-result）
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
        content: `[收敛] 检测到重复动作（第 ${rv.count + 1} 次相同文件读取）——该文件内容已在前面的工具结果中返回过——不要重复读取，直接基于已有结果推进下一步（设计/实现/测试/完成）。` });
      input.logger?.(`[agent] step=${steps + 1} 重复动作引导（${fp.slice(0, 60)}）`);
      return undefined;
    }

    input.onTrace?.({ type: "tool-call", step: steps + 1, tool, args });
    const stepStart = Date.now();

    // （2026-08-14 T3：pick_tools 动态工具选择协议已废弃移除——工具面不再动态收窄）
    // ── ASP 门控（asp 模式——空间状态机）────────────────────────────
    if (aspMode) {
      // 空间生成/注销已移出 worker 工具面（2026-08-14 N8——T6 裁决：空间生成走优化通道/审批面；
      // 治理通道入口 = spaceRegistry.createChild/unregister——asp.create/asp.destroy 工具已退役）
      if (tool === "asp_cd") {
        const target = String(args["space"] ?? "");
        const sp = spaceRegistry.get(target);
        if (!sp) {
          messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
            content: `asp_cd: 未知空间 "${target}"（已注册: ${spaceRegistry.list().map((s) => s.id).join("/")}）` });
          return undefined;
        }
        // 空间-角色绑定校验（2026-08-14 N8——生成即绑定）：绑定空间拒绝非绑定角色进入（谱系上溯匹配）
        const { allLineageRoles } = await import("./worker-cluster.js");
        if (!isRoleBoundToSpace(sp, input.role ? { id: input.role.id, parent: input.role.parent } : undefined, allLineageRoles())) {
          const bound = (sp.bindRoles ?? []).join("/");
          messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
            content: `asp_cd: 空间 "${target}" 绑定 worker 类型 ${bound}——本角色（${input.role?.id ?? "?"}）不可进入。asp.index 查看你可进入的空间（基板全角色共享，绑定空间仅绑定类型可进）。` });
          input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: 0, resultPreview: `绑定拒绝 → ${target}` });
          return undefined;
        }
        aspSession.currentSpace = target;
        const hint = target === "meta"
          ? "元空间：无执行核——可用 done 提交任务。"
          : `可用执行工具：${sp.execTool}（语言代码仅在本空间可解析）。`;
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
          content: `已迁移到 ${target} 空间。${hint}` });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: true, durationMs: 0, resultPreview: `cd → ${target}` });
        return undefined;
      }
      if (tool === "asp_index") {
        const { buildSpaceIndex } = await import("./space-index.js");
        const out = await buildSpaceIndex(
          { mode: typeof args["mode"] === "string" ? args["mode"] : undefined, space: typeof args["space"] === "string" ? args["space"] : undefined },
          { currentSpace: currentSpace(), kernel, caps },
        );
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: out });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: true, durationMs: 0, resultPreview: out.slice(0, 120) });
        return undefined;
      }
      if (tool === "memory_index") {
        const { buildMemoryIndex } = await import("@away_from/pth-memory");
        const memory = (caps as { memory?: { query(sql: string): Promise<unknown>; retrieve(o: never): Promise<never[]>; get(id: string): Promise<unknown> } }).memory;
        if (!memory) {
          messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: "memory 能力不可用（本角色无 memory 包）" });
          return undefined;
        }
        const out = await buildMemoryIndex(
          { tag: typeof args["tag"] === "string" ? args["tag"] : undefined, id: typeof args["id"] === "string" ? args["id"] : undefined },
          { memory: memory as never, currentSpace: currentSpace() },
        );
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: out });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: true, durationMs: 0, resultPreview: out.slice(0, 120) });
        return undefined;
      }
      if (tool === "cache_index") {
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: cache.index() });
        return undefined;
      }
      if (tool === "cache_cancel") {
        const key = String(args["key"] ?? "");
        const removed = cache.cancel(key);
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
          content: removed ? `已释放缓存条目 "${key}"。` : `cache.cancel: 键 "${key}" 不存在（cache.index 查看当前条目）` });
        return undefined;
      }
      if (tool === "cache_load") {
        const memory = (caps as { memory?: { get(id: string): Promise<{ content: string } | undefined>; retrieve(o: never): Promise<Array<{ id: string; content: string }>> } }).memory;
        const push = (key: string, content: string, source: string) => {
          const r = cache.load(key, content, source);
          return r.ok ? `✓ ${key}（${content.length}c）` : `✗ ${key}：${r.reason}`;
        };
        const results: string[] = [];
        if (typeof args["key"] === "string" && typeof args["content"] === "string") {
          results.push(push(String(args["key"]), String(args["content"]), "custom"));
        } else if (memory) {
          const ids: string[] = Array.isArray(args["ids"]) ? (args["ids"] as unknown[]).map(String) : typeof args["id"] === "string" ? [String(args["id"])] : [];
          if (ids.length > 0) {
            for (const id of ids) {
              const e = await memory.get(id);
              results.push(e ? push(id, e.content, `memory:${id}`) : `✗ ${id}：条目不存在`);
            }
          } else if (typeof args["tag"] === "string") {
            const entries = await memory.retrieve({ anchors: [String(args["tag"])] } as never);
            for (const e of entries.slice(0, 10)) results.push(push(e.id, e.content, `memory:${e.id}`));
            if (entries.length === 0) results.push(`tag "${args["tag"]}" 无可见条目`);
          } else {
            results.push("cache.load: 需要 {id}/{ids}/{tag}（从记忆空间）或 {key, content}（自定义）");
          }
        } else {
          results.push("memory 能力不可用——仅支持 {key, content} 自定义载入");
        }
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
          content: `cache.load：\n${results.join("\n")}\n${cache.index().split("\n")[0]}` });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: true, durationMs: 0, resultPreview: results.join("; ").slice(0, 120) });
        return undefined;
      }
      // 语言执行工具仅在本空间可解析（下划线形工具名 → 空间反查；
      // 2026-08-14 N8：绑定空间继承基板工具族——同族多空间以当前空间族归属判定）
      const requiredSpace = spaceRegistry.spaceOfExecTool(tool);
      if (requiredSpace && currentSpace() !== requiredSpace && !spaceRegistry.spaceOwnsTool(currentSpace(), tool)) {
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
          content: `[ASP] 当前位于 ${currentSpace()} 空间——${tool} 不可在此解析执行。先 asp_cd("${requiredSpace}")。` });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: 0, resultPreview: `空间门控：需 ${requiredSpace}` });
        return undefined;
      }
      if (tool === "done" && currentSpace() !== "meta") {
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
          content: `[ASP] done 仅在元空间可用（当前 ${currentSpace()}）——先 asp_cd("meta") 再提交。` });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: 0, resultPreview: "done 门控：需 meta" });
        return undefined;
      }
    }

    if (tool === "done") {
      const result = args["result"];
      // 空产物判定：undefined/null/空对象/空数组/空字符串——都视为未提交实际产物（0/false 等合法 falsy 不误伤）
      const isEmptyResult =
        result === undefined || result === null ||
        (typeof result === "object" && !Array.isArray(result) && Object.keys(result).length === 0) ||
        (Array.isArray(result) && result.length === 0) ||
        (typeof result === "string" && result.trim().length === 0);
      if (isEmptyResult) {
        // 收尾引导（L2 运行时引导——不再立即 reject——回填引导让模型重新提交正确产物）
        const dv = emptyDoneGuard.step({ roleId: input.role?.id, tool, steps: steps + 1 }, true);
        input.onTrace?.({ type: "guard", step: steps + 1, guard: "empty-done", kind: dv.kind === "hard" ? "hard" : "hit", count: dv.count, limit: dv.limit });
        const guide = result === undefined || result === null
          ? "done 缺少 result（必填）——已拒绝：你的 done 调用未携带最终产出对象。请重新调用 done：result 必须为实际产物（实现代码/写入的文件/计算结果等任意 JSON），可附带 summary 说明完成情况。"
          : "done 的 result 为空（无实际产物内容）——已拒绝：空对象/空数组/空字符串不构成产物。请重新调用 done：result 必须为实际产物（实现代码/写入的文件/计算结果等任意 JSON），可附带 summary 说明完成情况。";
        const remaining = dv.limit - dv.count;
        messages.push({
          role: "tool",
          toolCallId: toolCallId ?? `tc-${steps + 1}`,
          toolName: tool,
          content: `step ${steps + 1} [done]: ${guide}（第 ${dv.count} 次空 done——剩余 ${remaining} 次机会，之后将强制终止）`,
        });
        input.logger?.(`[agent] step=${steps + 1} done 空 result 引导（第 ${dv.count}/${dv.limit} 次）`);
        input.onStep?.({ n: steps + 1, tool, durationMs: Date.now() - stepStart, ok: false, args: JSON.stringify(args).slice(0, 300) });
        input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: Date.now() - stepStart, resultPreview: guide.slice(0, 200) });
        if (dv.kind === "hard") {
          return { ok: false, error: `done 连续 ${dv.count} 次缺少 result（应携带实际产物）——已按失败终止`, steps: steps + 1 };
        }
        return undefined;  // 继续循环——模型看到引导后应重新调用 done 提交正确产物
      }
      // 2026-08-15 审计 MEDIUM-2：空 done 护栏只在真空 done 时 hit——有效 done 重置计数
      emptyDoneGuard.step({ roleId: input.role?.id, tool, steps: steps + 1 }, false);
      const summary = typeof args["summary"] === "string" ? args["summary"] : undefined;
      input.onStep?.({ n: steps + 1, tool, durationMs: Date.now() - stepStart, ok: true });
      // finish trace（task.done 活动事件源——trigger 引擎/console --follow 的完成信号——之前断链只在失败路径发）
      input.onTrace?.({ type: "finish", ok: true, steps: steps + 1, valuePreview: JSON.stringify(result).slice(0, 200) });
      return { ok: true, value: result, summary, steps: steps + 1 };
    }

    // tool_calls 名是 API 形式（下划线——python_execute）——映射回执行器（点）
    // 直觉别名（2026-08-13：模型对工具名的自然猜测——write_doc 幻视失败根因）——
    // 工具名应符合模型直觉：别名表把常见直觉名映射到正式工具
    const TOOL_ALIASES: Record<string, string> = {
      "write.doc": "write.create", "write_doc": "write.create", "doc.create": "write.create",
      "write.file": "write.create", "write_file": "write.create",
      "file.write": "dev.write", "file_write": "dev.write",
      "code.write": "dev.write", "code_write": "dev.write",
      "run": "dev.run", "build": "dev.build",
      "mem.index": "memory.index", "mem_index": "memory.index",
      "space.index": "asp.index", "space_index": "asp.index",
      "cd": "asp.cd", "goto": "asp.cd",
    };
    const rawKey = tool.replace(/_/g, ".");
    const executorKey = TOOL_ALIASES[rawKey] ?? TOOL_ALIASES[tool] ?? rawKey;
    const executor = AGENT_TOOLS[executorKey as keyof typeof AGENT_TOOLS];
    if (!executor) {
      // 能力函数被当动作工具输出（收敛兼容）：自动降级为 ts 程序执行。
      // 2026-08-12 审计 LOW-11 修复：下划线形（memory_query）同样降级——归一后查表
      const wrap = AGENT_CAPABILITY_AS_ACTION[tool] ?? AGENT_CAPABILITY_AS_ACTION[tool.replace(/_/g, ".")];
      if (wrap) {
        const code = wrap(args);
        input.logger?.(`[agent] step=${steps + 1} capability-action ${tool} → ts 程序降级`);
        // PTC 统一执行缝（2026-08-14 A1 Phase 2——执行+注册收敛进 ptc/runner；
        // Phase 3 条目 12——任务级 caps 装配随缝注入）
        const { raw } = await runPtcProgram({
          code, cwd: "/tmp", ts: kernel.ts, caps: input.capabilityInject,
          registerResult: { key: `result_${steps + 1}`, build: (r) => ({ tool, ok: r.ok, value: r.ok ? r.value : undefined, error: r.ok ? undefined : r.error }) },
        });
        const result: AgentToolResult = raw.ok
          ? { ok: true, value: raw.value, stdout: truncate(JSON.stringify(raw.value ?? null), 2000).text }
          : { ok: false, error: raw.error?.message ?? "ts execute failed" };
        input.onStep?.({ n: steps + 1, tool, durationMs: Date.now() - stepStart, ok: result.ok, args: JSON.stringify(args).slice(0, 300) });
        const summary = result.ok
          ? (result.stdout ?? JSON.stringify(result.value ?? null)).slice(0, 500)
          : `error: ${result.error ?? "unknown"}`;
        messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: `step ${steps + 1} [${tool}]: ${summary}` });
        return undefined;
      }
      // 未知工具回填引导（2026-08-13：不再直接失败——给模型纠错机会——
      // 模型幻觉工具名（write_doc）时引导正确工具名——连续 N 次才终止（N12 护栏））
      const uv = unknownToolGuard.step({ roleId: input.role?.id, tool, steps: steps + 1 }, true);
      input.onTrace?.({ type: "guard", step: steps + 1, guard: "unknown-tool", kind: uv.kind === "hard" ? "hard" : "hit", count: uv.count, limit: uv.limit });
      const knownNames = Object.keys(AGENT_TOOLS).filter((n) => n !== "done");
      const hint = knownNames.slice(0, 12).join("/");
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
        content: `未知工具 ${tool}（第 ${uv.count} 次）——可用工具如: ${hint}… 请用已注册工具名重试（下划线形也可）。` });
      input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: 0, resultPreview: `未知工具引导 ${tool}` });
      if (uv.kind === "hard") return { ok: false, error: `未知工具 ${tool}（连续 ${uv.count} 次）`, steps: steps + 1 };
      return undefined;
    }
    // 2026-08-15 审计 MEDIUM-2：工具已知且到达执行面——unknown-tool 护栏重置（非连续才不累积）
    unknownToolGuard.step({ roleId: input.role?.id, tool, steps: steps + 1 }, false);
    // 执行面角色授权（模块级 EXEC_TOOL_CAP——见顶部定义）
    const execFam = executorKey.split(".")[0];
    const needCaps = EXEC_TOOL_CAP[execFam];
    const roleCaps = input.role?.capabilities;
    if (needCaps && roleCaps && !needCaps.some((c) => (roleCaps as string[]).includes(c))) {
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool,
        content: `[授权] ${tool} 拒绝：本角色 capabilities 未含 ${needCaps.join("/")}（能力面声明了白名单——执行面按白名单门控）。` });
      input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: 0, resultPreview: "capabilities 授权拒绝" });
      return undefined;
    }
    try {
      const result = await executor(
        { kernel, caps, taskWorkspace: input.taskWorkspace, toolstore: input.toolstore, space: aspMode ? aspSession.currentSpace : undefined, ptcCaps: input.capabilityInject },
        args,
      );
      input.onStep?.({ n: steps + 1, tool, durationMs: Date.now() - stepStart, ok: result.ok, args: JSON.stringify(args).slice(0, 300) });
      // 结果注册表（ts 核内 results 对象——用户裁决）：每步工具结果自动注册供程序引用
      const resultKey = `result_${steps + 1}`;
      try {
        kernel.ts.registerResult?.(resultKey, {
          tool,
          ok: result.ok,
          value: result.ok ? result.value : undefined,
          stdout: (result.stdout ?? "").slice(0, 2000),
          error: result.ok ? undefined : result.error,
        });
      } catch {
        /* 注册失败不阻断（mock kernel 无 registerResult） */
      }
      // 轨迹摘要（截断防膨胀）
      const summary = result.quiet
        ? "[quiet] 静默执行（无输出）"
        : result.ok
          ? (result.stdout ?? JSON.stringify(result.value ?? null)).slice(0, 500)
          : `error: ${result.error ?? (result.stderr?.trim() ? result.stderr : "unknown")}`;
      // 负结果收敛窗口（S6 死循环机制——2026-08-13）：同工具族+同目标连续负结果
      // N=3 回填引导（该路径已确认不可用→换策略）、N=15 强制终止（2026-08-15 D2：5→15）
      const neg = isNegativeResult(result);
      const fam = toolFamily(tool);
      const tgt = actionTarget(tool, args);
      recentResults.push({ family: fam, target: tgt, neg });
      const negLimits = guardReg.negativeLimits();
      // 窗口下限 6，动态扩展至 ≥ 终止阈值 + 1（否则 N=15 时 6 步窗口永远计不满 15）
      const keepWindow = Math.max(RECENT_RESULTS_WINDOW, negLimits.terminate + 1);
      while (recentResults.length > keepWindow) recentResults.shift();
      // 2026-08-14 T5 侦察豁免进豁免矩阵（N12）——guardReg.exempt("negative-loop") 声明式判定
      const reconExempt = guardReg.exempt("negative-loop", { roleId: input.role?.id, tool, steps: steps + 1 });
      const loopCheck = negativeLoopCheck(recentResults, fam, tgt, neg, !reconExempt, negLimits.terminate, negLimits.guideAt);
      if (loopCheck.action !== "none") {
        input.onTrace?.({ type: "guard", step: steps + 1, guard: "negative-loop", kind: loopCheck.action === "terminate" ? "soft" : "guide", count: loopCheck.count, limit: negLimits.terminate });
      }
      // 2026-08-15 审计 MEDIUM-1：引导与真实结果必须合并进同一条 tool 消息——
      // 同一 toolCallId 两条 tool 消息会被 llm-fn first-wins 去重，引导从未到达模型
      const guideSuffix = loopCheck.action === "guide"
        ? `\n[收敛] 检测到连续 ${loopCheck.count} 次负结果（${fam} · ${tgt}）——该路径已确认不可用——不要继续探测/重试同一目标——换策略（优先查 capability-index/ext-registry 权威列表，替代盲探测）。`
        : "";
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: `step ${steps + 1} [${tool}]: ${summary}${result.truncated ? " (truncated)" : ""}${guideSuffix}` });
      input.logger?.(`[agent] step=${steps + 1} tool=${tool} ok=${result.ok} args=${JSON.stringify(args).slice(0, 300)}`);
      input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: result.ok, durationMs: Date.now() - stepStart, resultPreview: summary.slice(0, 500) });
      if (loopCheck.action === "terminate") {
        return { ok: true, value: null, steps: steps + 1, warning: `连续 ${loopCheck.count} 次负结果（${fam} · ${tgt}）——负验证循环，强制终止` };
      }
      if (loopCheck.action === "guide") {
        input.logger?.(`[agent] step=${steps + 1} 负结果引导（${fam} · ${tgt} ×${loopCheck.count}）`);
        return undefined;
      }
      return undefined;  // 继续循环
    } catch (e) {
      // 工具执行异常（参数错误等）→ 回填错误让 LLM 修正（不算失败）
      messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: `step ${steps + 1} [${tool}]: 工具异常 ${(e as Error).message}` });
      input.logger?.(`[agent] step=${steps + 1} tool=${tool} error=${(e as Error).message}`);
      return undefined;
    }
  }
}

/**
 * runAgentTask（压缩包装——2026-08-10）：内核执行 + 结束压缩（CoT 模板）。
 * 认知模型：压缩是必备功能（提前实现）；评估读取压缩产物。done/失败都压缩
 * （失败的思维过程对评估价值更高）。压缩失败不阻断任务结果。
 */
export async function runAgentTask(input: AgentTaskInput & AgentLoopOptions): Promise<AgentTaskResult> {
  const result = await runAgentTaskCore(input);
  try {
    const messages = (input as { __messages?: Array<import("./context-compaction.js").CompactableMessage> }).__messages;
    if (messages && messages.length >= 4) {
      const { compressContext, COT_TEMPLATE } = await import("./context-compaction.js");
      result.compression = await compressContext(
        { llm: input.llm },
        { messages, template: COT_TEMPLATE, taskTitle: input.task.title },
      );
    }
  } catch { /* 压缩失败容忍——任务结果为主 */ }
  return result;
}
