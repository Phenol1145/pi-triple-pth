/**
 * impls/index.ts —— impls 模块公共 API（Phase D barrel 纪律）。
 *
 * 只导出不反向依赖 execution 的叶子实现（角色/空间/web-transport）。
 * capability/kernel-manager/ts-interpreter 仍由 `impls/kernels/index.js` 或具体文件提供，
 * 避免 execution → impls → execution 的 static-runtime 环。
 */
export * from "./kernels/web-transport.js";
export * from "./roles/default-roles.js";
export * from "./spaces/builtin-spaces.js";
