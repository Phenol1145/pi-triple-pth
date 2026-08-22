/**
 * agent-loop-prompt.ts —— agent system prompt 与 ASP 工具面（模块专项 ② 大文件拆分：自 agent-loop.ts 抽出）。
 */
import type { WorkerRole } from "./worker-cluster.js";
import { AGENT_CAPABILITY_DOC, toolsDescription, toolsForExecTool, toolSchemaFor, expandToolGroups, toolsToSchema } from "./agent-tools.js";
import { spaceRegistry } from "@away_from/pth-kernel-interpreter";
import { pthConfig } from "@away_from/pth-config";

/** 执行面角色授权（2026-08-12 审计 HIGH-2 修复）：语言/生产工具需对应 capability——
 *  capabilities 声明了但未含所需 → 拒绝（未声明 = 全量兼容；ts 族为基础执行面不校验） */
export const EXEC_TOOL_CAP: Record<string, string[]> = {
  python: ["python"], bash: ["bash"],
  dev: ["c", "dev", "python", "bash"],   // dev.run/list 只读——验收角色（python/bash）可用
  write: ["fs", "write"],
};

/** 直觉别名（2026-08-13：模型对工具名的自然猜测——write_doc 幻视失败根因）——
 * 2026-08-15 审计 LOW：别名归一提前到门控/护栏之前（asp 空间门控、execTool 授权
 * 都按归一后名字判定——此前 cd/space.index 等别名绕过了 ASP 门控）。 */
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

/** 工具名归一：下划线形 → 点形（API tool name 合法化）+ 直觉别名映射 */
export function normalizeToolName(raw: string): string {
  const dot = raw.replace(/_/g, ".");
  return TOOL_ALIASES[dot] ?? TOOL_ALIASES[raw] ?? dot;
}

/** ASP 模式工具面（按当前空间动态计算——环境函数全空间可用，语言工具仅本空间，done 仅元空间）
 *  actionTools 白名单过滤（2026-08-12 审计 HIGH-2 修复）：角色声明了 actionTools →
 *  schema 面按其过滤（与 prompt 文本描述一致）；未声明 = 全量兼容（用户裁决）。 */
export function toolsForSpace(spaceId: string, actionTools?: string[]): import("@earendil-works/pi-ai").Tool[] {
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

/** N28 T6：冻结任务工具 union（schema/prompt/执行器共用同一集合）。
 *  ASP 开：快照 meta + 当前已注册空间，union toolsForSpace(space, role.actionTools)，
 *  canonicalize 名并恒含 protocol-pinned done；ASP 关：toolsToSchema(...,{asp:false}) + done。 */
export function taskToolUnion(actionTools: string[] | undefined, opts: { asp: boolean }): import("@earendil-works/pi-ai").Tool[] {
  const byName = new Map<string, import("@earendil-works/pi-ai").Tool>();
  const add = (tools: import("@earendil-works/pi-ai").Tool[]) => {
    for (const tool of tools) byName.set(normalizeToolName(tool.name), tool);
  };
  if (opts.asp) {
    add(toolsForSpace("meta", actionTools));
    for (const space of spaceRegistry.list()) add(toolsForSpace(space.id, actionTools));
  } else {
    add(toolsToSchema(actionTools, { asp: false }));
  }
  const done = toolSchemaFor("done");
  if (done) byName.set("done", done);
  return [...byName.values()];
}

/** ASP 模式 system prompt 附加块（协议世界观——空间/迁移/完成规则；
 *  2026-08-14 N8 修订：空间从「先验基板」到「派生结构」——基板全角色共享，绑定空间仅绑定类型可进；
 *  空间由系统随 worker 分化/注意力管理生成——worker 不创建/注销空间（生成走优化通道+审批面）） */
export const ASP_BLOCK = "【动作空间协议（ASP）】\n你在【元空间】开始——元空间无执行核，语言代码不可在此解析。\n- 探索：asp_index() 查看你可进入的空间（语言执行基板 ts/python/bash/dev/write 全角色共享；绑定空间仅绑定 worker 类型可进入——索引会标注）\n- 执行：asp_cd 切换——asp_cd(\"ts\")（ts 程序空间——能力包 memory/llm/web/fs/state 等）/ asp_cd(\"python\") / asp_cd(\"bash\")；产物生产：asp_cd(\"dev\")（代码——dev.*/debug.*）/ asp_cd(\"write\")（文档——write.*）\n- 空间数据是本地的：ts 里声明的变量在 python 空间不可见（跨空间携带信息用记忆/缓存工具）\n- 空间由系统生成（随 worker 分化/注意力管理需要）——你不需要也不可创建/注销空间\n- 完成任务：asp_cd(\"meta\") 回到元空间 → done 提交（done 仅在元空间可用）";


export const PTH_WORKER_SYSTEM = `【PTH Worker 世界观】（你在哪/怎么工作）
你是 PTH（Pi-Triple-Heavy）任务池的 worker——处理任务池分配的【单个任务】。
PTH = 服务器端任务内核：任务池 → 角色路由 → worker 执行 → 产物提交 → 应用。

工作流：任务 → 理解（评估需要什么）→ 按需探索（先查 memory 既有资产 → 能力索引 → 源码）
→ 执行（PTC ts 程序组合能力）→ 产物（fs.task 写 / 结果对象）→ done 提交（result 必带产物）

框架事实：
- 记忆（memory）：PTH 共享知识层——先 query 查已有沉淀（task-insight/tool-function）——有价值洞察 write 沉淀
- 角色：内置角色正交分工——查你的角色文档：
  const r = await memory.query("SELECT content, meta FROM memory_entries WHERE id='role-doc:你的角色id' LIMIT 1")
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
      || (title.includes("tasks") && caps.has("tasks"))
      || (caps.has("web") || caps.has("llm") || caps.has("state") || caps.has("ext") || caps.has("env") || caps.has("skills") || caps.has("obs")) && title.includes("web/llm");
    if (matched) { keep.push(sec); matchedAny = true; }
  }
  if (!matchedAny) return doc;   // 无匹配（自由格式/新包）——原文
  return `${header}${keep.join("")}`;
}

export async function buildAgentSystemPrompt(
  role: WorkerRole | undefined,
  taskTitle: string,
  opts: { mode?: "eager" | "lazy" | "auto"; asp?: boolean; allowlist?: readonly string[]; memory?: { query(sql: string): Promise<Array<{ content: string }>> } } = {},
): Promise<string> {
  const { renderWorkerIndex, isPlanningRole } = await import("./worker-cluster.js");
  // 模式（2026-08-14 T2 裁决）：env 显式覆盖 > 角色类缺省——规划系 eager（高频稳定、缓存价值高），
  // 执行族/信息族 lazy（锚点先行——代码缺省不再 eager）；auto 按模型智力映射留待后续
  const planningRole = isPlanningRole(role?.id);
  const mode = opts.mode ?? (pthConfig().str("PTH_AGENT_MODE") === "eager" ? "eager" : pthConfig().str("PTH_AGENT_MODE") === "lazy" ? "lazy" : (planningRole ? "eager" : "lazy"));

  // 角色块：eager = 角色文档全文（memory query）；lazy = 指针
  let roleBlock = "";
  if (role) {
    if (mode === "lazy") {
      roleBlock = `你的角色：${role.id}。角色文档在 memory（id='role-doc:${role.id}'）——
先用 memory.query 查询它了解你的职责与工作方式：
SELECT content, meta FROM memory_entries WHERE id='role-doc:${role.id}' LIMIT 1\n（若查询不到——按人设执行：${role.prompt.slice(0, 120)}）`;
    } else {
      try {
        const rows = opts.memory ? await opts.memory.query(`SELECT content, meta FROM memory_entries WHERE id='role-doc:${role.id}' LIMIT 1`) : [];
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
const idx = await memory.query("SELECT content, meta FROM memory_entries WHERE kind='capability-index' LIMIT 1");\n（或用 fs.readText 读 toolstore 文件）——需要什么能力先查索引——不要盲试。
代码库结构（找文件/模块在哪/哪个文件做什么）——查 project-map：
const pm = await memory.query("SELECT content, meta FROM memory_entries WHERE kind='project-map' LIMIT 1");
源码阅读：fs.readSource（读索引可知用法）。任务工作区写入：fs.task（读索引可知）。`;
  } else {
    try {
      const rows = opts.memory ? await opts.memory.query("SELECT content, meta FROM memory_entries WHERE kind='capability-index' LIMIT 1") : [];
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
${toolsDescription(role?.actionTools, { asp: opts.asp, allowlist: opts.allowlist })}

${capBlock}

【API 调查技能】（当你不清楚执行核预定义函数/对象（fs/memory/llm/context 等）的构成、参数、语法或返回值时）
const skill = await memory.query("SELECT content, meta FROM memory_entries WHERE id='skill:api-investigation' LIMIT 1");
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

