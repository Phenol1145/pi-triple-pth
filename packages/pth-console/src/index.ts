/**
 * @away_from/pth-console — PTH Console 公共入口（barrel）。
 *
 * 导出 PTH 侧核心能力（client/protocol/pack + operator-console 服务器）。
 * pth CLI 交互命令实现在 ./commands/（由 scripts/pth-cli.ts 动态加载）。
 */
export * from "./bridge/client-types.js";
export * from "./bridge/client.js";
export * from "./bridge/manifest.js";
export * from "./bridge/pack.js";
export * from "./bridge/ustar.js";
export * from "./operator-console/index.js";
