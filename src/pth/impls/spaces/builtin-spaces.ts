/**
 * impls/spaces/builtin-spaces.ts —— 内置动作空间（兼容 re-export）。
 *
 * 模块化优化 P0：定义数据已下移 kernel/execution/builtin-spaces.ts（断开 kernel→impls 反向边）。
 * 新代码请直接 import kernel/execution/builtin-spaces.js；本文件仅为既有消费者保留。
 */
export { BUILTIN_SPACE_DEFS, registerBuiltinSpaces } from "@away_from/pth-kernel-execution";
