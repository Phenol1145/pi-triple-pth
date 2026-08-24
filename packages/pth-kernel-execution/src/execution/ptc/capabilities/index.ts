/**
 * ptc/capabilities/index.ts —— TCE W1：dev/write/debug 能力对象统一出口。
 */

export { createDevCapability, type DevCapability, type DevCapabilityDeps } from "./dev.js";
export { createWriteCapability, type WriteCapability, type WriteCapabilityDeps } from "./write.js";
export { createDebugCapability, type DebugCapability, type DebugCapabilityDeps } from "./debug.js";
