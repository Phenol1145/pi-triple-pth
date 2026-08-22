/**
 * 项目全貌文档生成（project-map——公共记忆区注入——worker 一次读知道代码库结构）。
 * 用法：npx tsx scripts/gen-project-map.ts（ts 依赖链——.js 扩展解析需要 tsx）
 * 输出：stdout markdown（人工 review / CI 检查——运行时注入由 injectPromptDocs 完成）
 * 单源：复用 src/pth/kernel/prompt-docs.ts 的 buildProjectMap（职责表只维护一份）
 */
import { buildProjectMap } from "@away_from/pth-kernel-execution";

const map = await buildProjectMap();
console.log(map);
