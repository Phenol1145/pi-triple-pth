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

## 文件与工作区
- fs.readText(path): 读 toolstore 文件（只读——代码库/扩展/文档）
- fs.list(dir?): 列 toolstore 目录
- fs.readSource(relPath): 读 PTH 源码（src/ 下 .ts——白名单只读——自修改用）
- fs.task.write(relPath, content): 写任务工作区文件（相对路径——产物/补丁落盘）
- fs.task.read(relPath): 读任务工作区文件
- fs.task.list(): 列任务工作区

## 执行核
- ts: 当前程序本身（组合一切）
- python.execute({code}): python 执行（sandbox）
- bash.execute({command}): bash 命令（sandbox）
- c.execute(language, source): 编译执行（C——gcc/clang/tcc——sandbox）

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
