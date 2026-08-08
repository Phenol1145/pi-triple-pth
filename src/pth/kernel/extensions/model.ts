/**
 * extensions/model.ts —— model 扩展（标准扩展包成员，v1 骨架）。
 * 会话级模型状态对象（ts 核内）——model.set/get/usage 能力函数 Phase 3 接入
 * （agent-loop complete 选择链：显式 model > ts 核 model.current > env）。
 */

import type { TsReplExtension } from "./index.js";

export const modelExtension: TsReplExtension = {
  id: "model",
  seed: () => ({
    // 会话模型状态：{ current, history: [{model, at, reason}], usage: {input, output} }
    model: { current: null, history: [], usage: { input: 0, output: 0 } },
  }),
  doc: `- model: 会话模型状态对象（model.current 当前模型——程序内可读；model.set/get/usage 能力 Phase 3 接入）`,
};
