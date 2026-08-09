/**
 * self-modify.ts — 自修改 v1：PTH 自修改指南注入公共记忆区
 *
 * 仿照 PTL 公共记忆区（extension-index 模式）：启动时把 PTH 源码指南写入
 * memory_entries（kind: self-modify-guide）——developer worker 用 memory.query
 * 读到指南（源码结构/修改流程/不变量）→ 再 fs.readSource 读源码 → sandbox 编码
 * → 提交补丁产物。PTH 自修改闭环（v0.9 前置——v1 单步修改）。
 *
 * 指南内容：源码布局/关键文件/修改流程/不变量。注入幂等（同 content 覆盖）。
 */

import type { PgMemoryStore } from "./storage/memory-store-pg.js";

export const SELF_MODIFY_GUIDE = `# PTH 自修改指南（v1——单步修改）

## 源码布局（src/ 下——readSource 只读面）
- src/pth/main.ts                 入口（装配 kernel + 服务器 + autopilot）
- src/pth/kernel/assembly.ts      kernel 装配（pg/dataWorld/BatchManager/watchdog）
- src/pth/kernel/execution/       task-loop（任务执行）/ batch-process（worker 池）
                                  worker-cluster（角色谱系）/ role-router（路由三段式）
                                  perf-autopilot（参数自愈）/ event-bus（事件）
- src/pth/kernel/interpreter/     kernel-manager（统一路由）/ capability（能力面）
                                  ts-interpreter（vm）/ sandbox-kernel（sandbox 转发）
                                  toolstore（文件通道）/ read-source（源码只读）
- src/pth/kernel/storage/         task-store-pg（任务表）/ memory-store-pg（记忆）
- src/pth/kernel/extensions/      扩展（ext-manifest/ext-registry/ext-capability）
- src/sandbox/kernel-host.ts      sandbox kernel 宿主（池/编译核/调试）

## 修改流程（单步）
1. memory.query 读本指南 + 相关文档（kind 过滤）
2. fs.readSource 读目标源码（src/ 下 .ts）
3. 设计修改（保持既有风格：中文注释/类型严格/防御性）
4. c.execute 或 sandbox 验证（编译/语法检查）
5. 提交产物：{ file, original (片段), modified (片段), reason, testHint }
   —— v1 产物人工审核应用（不自动写回）

## 不变量（修改不得违反）
- 不删除/移动 .pi-platform-data（生产数据）
- 不触碰 host redis / dev 容器
- C/Rust 等编译型核只在 sandbox 运行（主容器无编译器）
- 单大 batch 默认（内存最优）——worker 级控制为主扩缩
- 扩展生态 = 代码库形式（toolstore/memory——零新注册机制）
- 权限层 = 注入面收窄（不给不拦截——capabilities 白名单）
- 任务路由正交化（flow 显式 → tags 语义 → hash 分片——零竞速）

## 测试约定
- vitest（test/ 目录——pth-* 分组）
- 全量门禁：npx vitest run + npx tsc -p tsconfig.json --noEmit
- 发布门禁：bash scripts/check-release-clean.sh`;

/** 注入自修改指南（公共记忆区——幂等）——启动时调用 */
export async function injectSelfModifyGuide(memory: PgMemoryStore): Promise<void> {
  try {
    await memory.write({
      id: "self-modify-guide",   // 固定 id——幂等覆盖（version 递增）
      kind: "self-modify-guide",
      anchors: ["self-modify", "guide", "源码", "自修改"],
      content: SELF_MODIFY_GUIDE,
      status: "official",
      meta: { source: "injectSelfModifyGuide" },
    });
  } catch (e) {
    // 注入失败不阻断启动（worker 侧可再查）
    console.warn(`[self-modify] 指南注入失败（放行）: ${(e as Error).message}`);
  }
}
