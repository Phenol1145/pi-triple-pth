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

import type { PgMemoryStore } from "./storage/memory-store-pg.js";
import { allWorkerRoles } from "./execution/worker-cluster.js";
import { buildDoc } from "./extensions/index.js";

/** 角色文档生成（人设/任务类型/工作偏好）——lazy 下 LLM 按需读 */
export function buildRoleDoc(role: { id: string; labelPatterns: string[]; prompt: string }): string {
  return `# 角色：${role.id}

## 人设
${role.prompt}

## 任务类型（你负责的任务标签语义）
${role.labelPatterns.join(" / ")}

## 工作方式
- 任务描述会在 user 消息给出——按 PTC 模式用 ts 程序组合能力完成
- 结果用 done 工具提交（result 对象 + summary 说明）
- 信息不足时：先读能力索引（memory kind='capability-index'）了解可用能力，再读相关文档/源码
- 遵守 PTH 不变量（见 self-modify-guide——若涉及修改系统）`;
}

/** 能力索引生成（全部能力函数文档——新核/新能力接入点）——eager 注入 / lazy 指针目标 */
export function buildCapabilityIndex(): string {
  const extDoc = buildDoc();
  return `# PTH 能力索引（ts 程序内可调用——await 调用；组合/联动在程序内完成）

## 标准能力（扩展包）
${extDoc}

## 基础对象
- results: 每步工具结果自动注册（results["result_N"] = {tool, value, stdout}）；程序内可读写
- context: 跨步骤 KV（context.my_key = ...；后续程序直接读）

## 文件与工作区（确切签名——参数/返回）
- fs.readText(path: string) → Promise<string>
  path = toolstore 相对路径（如 "extensions/hello-world/index.ts"）
- fs.list(dir?: string) → Promise<string[]>   （列 toolstore 目录）
- fs.readSource(relPath: string) → Promise<string>
  relPath = 相对【/app/src】——写 src/ 前缀（如 "src/pth/kernel/extensions/context.ts"）
- fs.task.write(relPath: string, content: string) → Promise<{ok, path, bytes}>
  relPath = 任务工作区相对路径（防穿越——只写自己目录）
- fs.task.read(relPath: string) → Promise<string>
- fs.task.list() → Promise<Array<{name, isDir}>>

## 执行核（确切签名）
- python.execute(code: string) → Promise<{ok, stdout, stderr, value, durationMs}>
  code = python 源码字符串（【不是对象】——第一参数字符串）
- bash.execute(command: string) → Promise<{ok, stdout, stderr, durationMs}>
  command = shell 命令字符串（第一参数字符串）
- c.execute(language: string, source: string) → Promise<{ok, stdout, result}>
  language = "gcc"|"clang"|"tcc"
- ts 程序：能力函数 await 调用；return 值 + stdout 回填

## 其他
- llm.complete: LLM 调用（嵌套 agent/评估）
- web: HTTP 获取
- state: 记忆召回（recallFunctions/recallInsights）
- ext: 扩展编排（index/use/kernel/syncIndex——代码库式扩展）
- env.inspect: 环境状态摘要

## 新能力接入
能力函数加入后在本索引追加记录——worker 下次读取即发现（prompt 模板零改动）`;
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
  // 角色文档（内置 + 扩展角色——allWorkerRoles）
  for (const role of allWorkerRoles()) {
    try {
      await memory.write({
        id: `role-doc:${role.id}`,
        kind: "role-doc",
        anchors: ["role-doc", role.id, "角色", "prompt"],
        content: buildRoleDoc(role),
        status: "official",
        meta: { source: "injectPromptDocs", role: role.id },
      }, { force: true });
    } catch { /* 单角色注入失败放行 */ }
  }
  // 能力索引
  try {
    await memory.write({
      id: "capability-index",
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
- 角色：内置角色正交分工——你的职责见 role-doc（memory 查询 kind='role-doc:<你的角色>'）
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
  // API 调查技能（lazy 探索方法论——按需读取）
  try {
    await memory.write({
      id: "skill:api-investigation",
      kind: "skill",
      anchors: ["skill", "api-investigation", "调查", "签名", "语法"],
      content: API_INVESTIGATION_SKILL,
      status: "official",
      meta: { source: "injectPromptDocs" },
    }, { force: true });
  } catch { /* skill 注入失败放行 */ }
}
