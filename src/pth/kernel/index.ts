/**
 * kernel/index.ts — kernel 模块公共 API（模块化优化 P3c barrel 纪律）。
 *
 * 代码已拆分为 @away_from/pth-kernel-* 子包；本文件保留旧 kernel 顶层门面，
 * 供 gateway 等仍从 `../kernel/index.js` 消费的调用方使用。assembly.ts 是组合根，
 * 仍保留在本目录（依赖 catalog/tasking）。
 */
export * from "./assembly.js";
export * from "@away_from/pth-kernel-execution";
export {
  listPublicTemplates,
  resolveTemplateTask,
  type TaskTemplate,
  type TemplateTaskResolution,
  type TemplateTaskSpec,
} from "@away_from/pth-kernel-interpreter";
