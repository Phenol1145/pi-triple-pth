/**
 * extensions/model.ts —— model 扩展（会话内模型切换——Phase 3 能力函数接入）。
 *
 * 闭环设计：模块级 modelState 单例——
 *   seed 注入 vm（model 对象 = 同一引用）→ 程序内 model.current 可读
 *   provide 注入能力函数（set/get/usage 操作同一引用）→ agent-loop readObject("model")
 *   读到同一对象 → 选择链动态层成立
 */

import type { TsReplExtension } from "./index.js";

export interface ModelState {
  current: { provider?: string; model: string } | null;
  history: Array<{ model: string; at: number; reason?: string }>;
  usage: { input: number; output: number };
  set(opts: { provider?: string; model: string; reason?: string }): { ok: true; current: { provider?: string; model: string } };
  get(): { provider?: string; model: string } | null;
  usageInfo(): { input: number; output: number };
}

/** 模块级单例（vm 内 model 对象与能力函数共享同一引用——agent-loop 直接 import 读取） */
export const modelState: ModelState = {
  current: null,
  history: [],
  usage: { input: 0, output: 0 },
  set(opts) {
    const cur = { provider: opts.provider, model: opts.model };
    modelState.current = cur;
    modelState.history.push({ model: opts.model, at: Date.now(), reason: opts.reason });
    return { ok: true, current: cur };
  },
  get() {
    return modelState.current;
  },
  usageInfo() {
    return { ...modelState.usage };
  },
};

export const modelExtension: TsReplExtension = {
  id: "model",
  seed: () => ({ model: modelState }),
  provide: () => ({ model: modelState }),
  doc: `- model: 会话模型状态与切换——model.current 当前模型（{provider, model}）；model.set({model, provider?, reason?}) 切换会话模型（后续 LLM 调用生效）；model.get() 当前；model.usage() token 消耗（{input, output}）`,
};
