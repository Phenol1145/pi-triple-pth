/**
 * prompt-docs.ts — Prompt 文档化（2026-08-09：Prompt 框架化——memory 作为 prompt 数据源）
 *
 * 设计（用户裁决）：
 *   - Prompt 从"手写文本"变为"模板 + 文档数据源 + 渲染参数"
 *   - 角色文档（role-doc:<role>）/ 能力索引（capability-index）存入 memory——
 *     lazy 模式 LLM 按需 query（与 memory 检索同构）；eager 模式渲染层 query 后注入
 *   - 新核/新角色接入：更新索引/角色文档（memory 记录）——prompt 模板零改动
 *   - 单一查询面：模型可读信息（角色/能力/指南/知识沉淀）都在 memory
 */

import { DEFAULT_TENANT_ID, type PgMemoryStore } from "@away_from/pth-memory";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { allLineageRoles } from "./execution/worker-cluster.js";
import { DEFAULT_REFINE_TASKS } from "./execution/refiner.js";
import { buildDoc } from "@away_from/pth-kernel-interpreter";
import { buildCapabilityIndexDoc } from "@away_from/pth-kernel-interpreter";
import { SEED_SKILL_SOPS, SEED_OPT_SOPS, SEED_LEAF_SOPS, buildSkillContent } from "@away_from/pth-memory";

/** 角色文档生成（人设/任务类型/工作偏好 + 谱系元数据 + T8 场景锚点三要素——lazy 下 LLM 按需读） */
export function buildRoleDoc(role: {
  id: string; tags: string[]; prompt: string;
  thinking?: string; description?: string; output?: string;
  defaultReads?: string[]; acceptanceRole?: string; capabilities?: string[];
  parent?: string; generation?: number; differentiation?: string;
}): string {
  const meta: string[] = [];
  if (role.thinking) meta.push(`推理深度：${role.thinking}`);
  if (role.acceptanceRole) meta.push(`验收角色：${role.acceptanceRole}`);
  if (role.generation !== undefined) meta.push(`谱系代数：${role.generation}${role.parent ? `（父角色：${role.parent}）` : "（谱系之根）"}`);
  const metaLine = meta.length > 0 ? `## 谱系元数据
${meta.map((m) => `- ${m}`).join("\n")}

` : "";
  const lineageSection = role.differentiation
    ? `## 分化路径（树状谱系——Origin 根 → 任务分化诱导）\n- 分化诱导：${role.differentiation}\n\n`
    : "";
  const capSection = role.capabilities && role.capabilities.length > 0
    ? `## 访问权限（PTC 能力白名单——你可调用的函数）\n${role.capabilities.map((c) => `- ${c}`).join("\n")}\n\n`
    : "";
  const ioSection = (role.output || role.defaultReads?.length)
    ? `## 产物约定\n${role.output ? `- 默认产出：${role.output}\n` : ""}${role.defaultReads?.length ? `- 默认读取（上游产物）：${role.defaultReads.join(" / ")}\n` : ""}\n`
    : "";
  // D4（2026-08-15）：role-doc 文案对齐 T8 场景锚点三要素——与工具 schema/能力索引同标准
  const anchor = role.description ?? `${role.id}——${role.prompt.slice(0, 80)}`;
  const effect = [
    role.output ? `默认产出 ${role.output}` : "done 提交实际产物",
    role.acceptanceRole ? `验收侧 ${role.acceptanceRole}` : "",
    role.defaultReads?.length ? `默认读取上游产物 ${role.defaultReads.join("/")}` : "",
  ].filter(Boolean).join("；");
  const anchorSection = `## 场景锚点三要素（T8）
- 【场景锚点】${anchor}
- 【何时用】任务标签命中 ${role.tags.join(" / ")} 之一，且需要本角色职责（${anchor}）时用。
- 【效果】${effect}

`;
  return `# 角色：${role.id}

${anchorSection}## 人设
${role.prompt}

${role.description ? `## 职责\n${role.description}\n\n` : ""}${metaLine}## 任务类型（你负责的任务标签语义）
${role.tags.join(" / ")}

${capSection}${ioSection}${lineageSection}## 工作方式
- 任务描述会在 user 消息给出——按 PTC 模式用 ts 程序组合能力完成
- 结果用 done 工具提交（result 对象 + summary 说明——result 必填实际产物）
- 信息不足时：先读能力索引（memory kind='capability-index'）了解可用能力，再读相关文档/源码
- 遵守 PTH 不变量（见 self-modify-guide——若涉及修改系统）`;
}

/** 能力索引生成（全部能力函数文档——新核/新能力接入点）——eager 注入 / lazy 指针目标。
 * 分节约定（Agent-JIT 路径 B——filterCapabilityDoc 按包裁剪）：## 基础（全角色）/
 * ## memory / ## fs / ## 执行核（python/bash/c）/ ## web/llm/state/ext/env。
 * 角色声明 capabilities 时 eager 只注入相关节——收窄角色 prompt 减负。 */
export function buildCapabilityIndex(): string {
  const extDoc = buildDoc();
  // A1 遗留收口：能力条目由 PTC 注册表生成（ptc/docs.ts——契约与文档同一真相源），
  // 本函数只保留注册表外的两个静态段（探索核动作工具面 / 扩展注册与接入指引）。
  return `# PTH 能力索引（ts 程序内可调用——await 调用；组合/联动在程序内完成）

【能力分节】本索引按能力包分节（## 包名）——角色声明 capabilities 时只注入相关节（Agent-JIT 路径 B：capabilities 收窄 → prompt 减负）。
【条目格式】每条 = 签名 → 返回 + 何时用 + 效果（0.8.2 三要素锚点——「何时用」决定该不该调用，「效果」预告拿到什么）。

${buildCapabilityIndexDoc()}

## 探索核（动作工具面——单步 tool_call 投影；程序内调用走上面的 python/bash 核契约）
- python.run(code) → {ok, stdout, stderr, value, durationMs} —— python 程序（code = 源码字符串）。何时用：python 生态/数据计算的多语句。效果：_result 值回传。
- python.eval(code) → 同上 —— 单表达式。何时用：一行计算。效果：表达式值即结果。
- bash.run(command) → {ok, stdout, stderr, durationMs} —— 命令序列。何时用：环境操作/探测（产物写入不走 bash）。效果：stdout。
- bash.eval(command) → 同上 —— 单条命令。何时用：ls/cat/grep 快速探测。效果：stdout。
- 【生产核】C 产物开发：asp.cd("dev") → dev.write/build/run/save/list + debug.*（动作工具——ts 程序内不可调；探索核/生产核分立）
- 【生产核·文档】编写类任务：asp.cd("write") → write.create/edit/read/list/save + write.section（大纲→草稿→修订→定稿；无 build/debug）
- ts 程序：能力函数 await 调用；return 值 + stdout 回填

## 扩展注册（ext——已装载扩展）
${extDoc}

## 新能力接入
能力函数加入后先在 PTC 注册表登记三要素（签名/何时用/效果），本索引自动生成——worker 下次读取即发现（prompt 模板零改动）`;
}
/** API 调查技能文档（lazy 探索方法论——按需读取——不盲试） */
export const API_INVESTIGATION_SKILL = `# API 调查技能（执行核预定义函数/对象的构成与语法调查）

## 什么时候用
- 需要调用一个函数/对象但不清楚参数/返回/语法
- 需要了解执行核预定义对象（fs/memory/llm/context/results 等）的构成
- 能力索引描述笼统——需要确切用法

## 调查方法（按顺序——先调查后调用，不盲试）
1. 对象构成：Object.keys(obj) —— 列方法/属性（如 fs 有哪些方法）
2. 签名：fn.toString() —— 看函数源码（参数名/实现——推断签名）
3. 形状：typeof x · JSON.stringify(x) —— 检查返回值结构
4. 实现源码：fs.readSource("src/pth/kernel/interpreter/capability.ts") —— 看能力如何注入/定义
5. 试错：最小调用 + try-catch —— 从错误信息推断正确参数（错误信息是免费的调试器）
6. 文档：能力索引（capability-index）/ 扩展 doc / 自修改指南（memory）

## 原则
- 先调查后调用（不盲试——盲试浪费步骤）
- 错误信息是调试线索（读它——推断正确格式）
- 一次调查获得的信息用于后续所有调用（不重复调查）
- 常见路径前缀：toolstore 文件用相对路径（fs.readText）；源码用 src/ 下（fs.readSource）；
  任务工作区用相对路径（fs.task）`;

/** Prompt 文档注入 memory（幂等——启动时调用；固定 id 覆盖） */
export async function injectPromptDocs(memory: PgMemoryStore): Promise<void> {
  // 角色文档（谱系全量——含 Origin 根 + 内置 + 扩展角色——allLineageRoles）
  for (const role of allLineageRoles()) {
    try {
      await memory.write({
        id: `role-doc:${role.id}`,
        tenantId: DEFAULT_TENANT_ID,
        kind: "role-doc",
        anchors: ["role-doc", role.id, "角色", "prompt"],
        content: buildRoleDoc(role),
        status: "official",
        meta: { source: "injectPromptDocs", role: role.id },
      }, { force: true });
    } catch { /* 单角色注入失败放行 */ }
  }
  // refine 任务清单 seed（解硬编码——memory 缺失时注入默认三任务——之后可经管理面演化）
  for (const t of DEFAULT_REFINE_TASKS) {
    try {
      await memory.write({
        id: `refine-task:${t.id}`,
        tenantId: DEFAULT_TENANT_ID,
        kind: "refine-task",
        anchors: ["refine-task", t.id, t.persistKind],
        content: JSON.stringify(t, null, 2),
        status: "official",
        meta: { source: "injectPromptDocs", seed: true },
      }, { force: true });
    } catch { /* 单条 seed 失败放行 */ }
  }
  // 能力索引
  try {
    await memory.write({
      id: "capability-index",
      tenantId: DEFAULT_TENANT_ID,
      kind: "capability-index",
      anchors: ["capability-index", "能力", "索引", "工具"],
      content: buildCapabilityIndex(),
      status: "official",
      meta: { source: "injectPromptDocs" },
    }, { force: true });
  } catch { /* 索引注入失败放行 */ }
  // PTH Worker 世界观（详细版——受保护——lazy 可查完整规则）
  try {
    await memory.write({
      id: "pth-worker-system",
      tenantId: DEFAULT_TENANT_ID,
      kind: "pth-worker-system",
      anchors: ["pth-worker-system", "世界观", "worker", "框架"],
      content: `# PTH Worker 系统提示（世界观——所有角色共享）

## 你在哪
你是 PTH（Pi-Triple-Heavy）任务池的 worker——处理任务池分配的【单个任务】。
PTH = 服务器端任务内核：任务池 → 角色路由 → worker 执行 → 产物提交 → 应用。

## 你的工作流
任务 → 理解（评估需要什么能力）→ 按需探索（先查 memory 既有资产 → 能力索引 → 源码）
→ 执行（PTC ts 程序组合能力）→ 产物（fs.task 写 / 结果对象）→ done 提交（result 必带产物）

## 框架事实
- 记忆（memory）：PTH 共享知识层——先 query 查已有沉淀（task-insight/tool-function/refine-report）
  ——有价值洞察 write 沉淀（kind=task-insight）
- 角色：内置角色正交分工——你的职责见 role-doc（memory 查询 id='role-doc:<你的角色>'）
- 产物：fs.task 写任务工作区 → 归档 → 人工/系统应用
- 改系统：fs.readSource 读源码 + 遵循 self-modify-guide（不变量）

## 约束
- 完成标准：有实际产物（实现/文件/结果）——不空 done
- 推进纪律：理解够即转实现——不无限探索（探索有预算）
- 探索顺序：先 memory 既有资产 → 能力索引 → 源码（不重复查——API 调查技能见 skill:api-investigation）
- sandbox 零敏感 · 扩展代码库式 · 权限注入面收窄 · 任务正交路由`,
      status: "official",
      meta: { source: "injectPromptDocs" },
    }, { force: true });
  } catch { /* 世界观注入失败放行 */ }
  // 项目全貌（project-map——代码库结构——worker 一次读知道在哪读什么——受保护）
  try {
    await memory.write({
      id: "project-map",
      tenantId: DEFAULT_TENANT_ID,
      kind: "project-map",
      anchors: ["project-map", "项目全貌", "代码库结构", "模块地图", "架构"],
      content: await buildProjectMap(),
      status: "official",
      meta: { source: "injectPromptDocs" },
    }, { force: true });
  } catch { /* 全貌生成失败放行 */ }
  // API 调查技能（lazy 探索方法论——按需读取）
  try {
    await memory.write({
      id: "skill:api-investigation",
      tenantId: DEFAULT_TENANT_ID,
      kind: "skill",
      anchors: ["skill", "api-investigation", "调查", "签名", "语法"],
      content: API_INVESTIGATION_SKILL,
      status: "official",
      meta: { source: "injectPromptDocs" },
    }, { force: true });
  } catch { /* skill 注入失败放行 */ }
  // 角色 SOP 种子（2026-08-15 B4 Phase 1 / B4-2 裁决 A）：
  // developer / scout / memory-keeper 三条四段式 SOP——从 role.prompt 提炼条目化。
  // 系统通道注入 + force 写（受 isSystemDocId 保护——worker 不可覆盖；kind=skill 属 prompt 层只读）。
  // N14 P3（2026-08-18）：+ 分层 SOP × 4（SEED_OPT_SOPS——0.17.4 四层次优化工作流标准）。
  // N17 A5（2026-08-18）：+ 叶子角色 SOP × 8（SEED_LEAF_SOPS——actuator 叶子角色四段式）。
  for (const seed of [...SEED_SKILL_SOPS, ...SEED_OPT_SOPS, ...SEED_LEAF_SOPS]) {
    try {
      await memory.write({
        id: `skill:${seed.id}`,
        tenantId: DEFAULT_TENANT_ID,
        kind: "skill",
        anchors: ["skill", seed.id, seed.id.replace(/-sop$/, ""), "SOP", "工作流"],
        content: buildSkillContent(seed),
        status: "official",
        meta: { source: "injectPromptDocs", seed: true, format: "skill-sop-v1" },
      }, { force: true });
    } catch { /* 单条 skill 注入失败放行 */ }
  }
}


// ============ 项目全貌（project-map——单源生成器——scripts/gen-project-map.ts 复用） ============

/** 目录职责映射（静态——新目录需补充——保持与 repo 同步） */
export const PROJECT_DIR_DUTY: Record<string, string> = {
  "src/pth/gateway": "HTTP 网关——任务/kernel/jobs 路由（REST API）",
  "src/pth/kernel/execution": "执行层——agent-loop（LLM 循环）/task-loop/batch/角色路由/收敛/PerfAutopilot",
  "src/pth/kernel/interpreter": "解释器——ts 核（PTC vm）/llm-fn/toolstore/exec-channel",
  "src/pth/kernel/extensions": "扩展能力——context/fs/obs/llm/perf——注入 ts 程序全局能力",
  "src/pth/kernel/storage": "持久化基座单包（2026-08-14 A2）——PG 数据世界（任务/转录/审计）+ session/ 会话平面（Redis）",
  "src/pth/kernel": "内核根——assembly/prompt-docs（Prompt 框架）/self-modify",
  "src/pth/observability": "可观测——kernel-metrics（prom）/resource-provider",
  "packages/pth-memory": "记忆域包（2026-08-15 拆分）——memory 存储/用途层策略/空间可见性/索引/治理执行/skill 格式/只读 SQL",
  "packages/pth-sandbox": "沙箱域包（2026-08-15 拆分）——内核契约/持久内核运行时/编译核/gdb/沙箱客户端与宿主",
  "src/shared": "共享——sdk-adapter（模型 SDK 适配）",
  "packages/framework": "PTL 运维框架——CLI/bridge（ptl hub）/containers（部署抽象）",
  "packages/infra": "模型基础设施——model-router",
  "packages/shared": "共享类型/工具——session-backend（tmux 会话抽象）",
  "toolstore": "代码库/扩展/文档存储——extensions/tests/templates",
  "extensions": "PTL 扩展——pth-tasks（任务提交）/agent-lab",
};

/** 关键文件职责（worker 常读——一次知道在哪读什么） */
export const PROJECT_FILE_DUTY: Record<string, string> = {
  "src/pth/kernel/execution/agent-loop.ts": "LLM agent 主循环（工具调用/收敛/世界观——worker 核心行为）",
  "src/pth/kernel/execution/agent-tools.ts": "agent 工具表（ts/python_execute/bash_execute/done）",
  "src/pth/bootstrap/task-loop.ts": "任务执行循环（NL 检测→agent/转译→轨迹收集）",
  "src/pth/bootstrap/batch-process.ts": "batch worker 进程（角色簇/内核/任务工作区注入）",
  "src/pth/kernel/execution/role-router.ts": "角色路由（任务→角色）",
  "src/pth/kernel/interpreter/ts-interpreter.ts": "ts 核（PTC vm——currentCwd 定位任务工作区）",
  "src/pth/kernel/interpreter/capability.ts": "能力构建（fs/memory/llm 注入）——fs.task 工作区",
  "src/pth/kernel/interpreter/llm-fn.ts": "LLM 函数（OpenAI 直连——tool_calls/reasoning_content）",
  "packages/pth-sandbox/src/sandbox-kernel.ts": "沙箱 kernel 客户端（HTTP acquire/execute）",
  "src/pth/kernel/extensions/context.ts": "context 扩展（工作台 KV——跨步骤状态）",
  "src/pth/kernel/prompt-docs.ts": "Prompt 框架（角色文档/能力索引/世界观/全貌注入 memory）",
  "packages/pth-memory/src/memory-store-pg.ts": "memory 存储（PG——query/write/静态文档保护）",
  "src/pth/kernel/storage/task-store-pg.ts": "任务存储（PG——提交/claim/产物）",
  "src/pth/gateway/server.ts": "HTTP 服务入口（路由挂载）",
  "src/pth/gateway/routes-kernel.ts": "kernel 路由（tasks/jobs/transcript）",
  "packages/pth-sandbox/src/kernel-host.ts": "沙箱宿主服务（kernel 池 acquire/execute/reset）",
};

async function walkProject(dir: string, depth: number, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  if (depth > maxDepth) return out;
  const entries = (await readdir(dir, { withFileTypes: true })).filter(
    (e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist" && e.name !== "__tests__",
  );
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const duty = PROJECT_DIR_DUTY[p];
      out.push(`${"  ".repeat(depth)}- ${e.name}/${duty ? ` — ${duty}` : ""}`);
      if (depth < maxDepth) out.push(...(await walkProject(p, depth + 1, maxDepth)));
    } else if (/\.(ts|json)$/.test(e.name) && e.name !== "package.json") {
      // 只列关键文件（有职责映射的——普通文件跳过——map 精简——关键路径一次知道）
      const duty = PROJECT_FILE_DUTY[p];
      if (duty) out.push(`${"  ".repeat(depth)}- ${e.name} — ${duty}`);
    }
  }
  return out;
}

/** 生成项目全貌 markdown（单源——injectProjectMap 与 scripts/gen-project-map.ts 共用） */
export async function buildProjectMap(): Promise<string> {
  const roots = ["src", "packages", "toolstore", "extensions"];
  const parts: string[] = [];
  parts.push("# PTH 项目全貌（project-map——代码库结构——worker 一次读知道在哪读什么）");
  parts.push("");
  parts.push("> 自动生成：injectPromptDocs 启动注入——静态职责映射（PROJECT_DIR_DUTY/FILE_DUTY）随 repo 演进维护。");
  parts.push("");
  parts.push("## 任务流（worker 在其中的位置）");
  parts.push("");
  parts.push("```");
  parts.push("任务提交（gateway/routes-kernel） → batch 分配（batch-manager） → 角色路由（role-router）");
  parts.push("→ task-loop 执行（agent 循环——agent-loop + agent-tools） → 产物（fs.task 工作区 / done result）");
  parts.push("→ 归档（outputRef） → refine 提炼（refine-report——沉淀 memory）");
  parts.push("```");
  parts.push("");
  parts.push("## 代码库结构");
  parts.push("");
  parts.push("```");
  for (const r of roots) {
    try {
      parts.push(...(await walkProject(r, 0, 3)));
    } catch { /* 目录缺失放行 */ }
  }
  parts.push("```");
  parts.push("");
  return parts.join("\n");
}
