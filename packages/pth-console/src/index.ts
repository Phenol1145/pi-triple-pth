/**
 * @away_from/pth-console — PTH Console 公共入口（barrel）。
 *
 * 只导出 PTH 侧核心能力（client/protocol/pack + operator-console 服务器）。
 * ptl hub 等 PTL CLI 命令实现位于 packages/framework/src/bridge/，
 * 经本包调用 PthClient（PTL → PTH 便捷调用方向）。
 */
export * from "./bridge/client-types.js";
export * from "./bridge/client.js";
export * from "./bridge/manifest.js";
export * from "./bridge/pack.js";
export * from "./bridge/ustar.js";
export * from "./operator-console/index.js";
