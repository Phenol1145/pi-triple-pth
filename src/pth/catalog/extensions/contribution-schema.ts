/**
 * catalog/extensions/contribution-schema.ts —— 兼容 re-export。
 *
 * 模块化优化 P0：纯校验 schema 上移 contracts（kernel ext-registry 与 catalog 同源消费，
 * 断开 kernel→catalog 反向边）。新代码请 import contracts/catalog-contribution-schema.js。
 */
export * from "@away_from/pth-contracts";
