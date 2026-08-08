/**
 * execution/model-router.ts — kernel 子进程的 LLM model router（试运行任务 1）
 *
 * 背景：batch-process 原用 stub modelRouter（llm 不可用不阻塞）。真实任务需要 LLM
 * （转写文档→记忆）。SDK 的 ModelRuntime.create() 自动加载 pi 的 auth.json + models-store
 * （deepseek 等 provider 已配置，实测读到 deepseek-v4-flash/pro）——本适配器包 SDK runtime，
 * 暴露 llm-fn 消费的最小面（resolve/getRuntime），默认 provider=deepseek。
 *
 * 零新依赖：仅 import @earendil-works/pi-coding-agent（sdk-adapter 已有边界）。
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface KernelRouterLike {
  resolve(provider?: string, model?: string): NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  getRuntime(): ModelRuntime;
}

const DEFAULT_PROVIDER = "deepseek";
const DEFAULT_MODEL = "deepseek-v4-flash";

export async function createKernelModelRouter(opts: {
  provider?: string;
  model?: string;
} = {}): Promise<KernelRouterLike> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const provider = opts.provider ?? process.env.PTH_MODEL_PROVIDER ?? DEFAULT_PROVIDER;
  const model = opts.model ?? process.env.PTH_MODEL ?? DEFAULT_MODEL;

  return {
    getRuntime: () => runtime,
    resolve: (p?: string, m?: string) => {
      const effProvider = p ?? provider;
      const effModel = m ?? model;
      const resolved = runtime.getModel(effProvider, effModel);
      if (resolved) return resolved;
      // 兜底：任意可用模型（deepseek 缺特定型号时）
      const fallback = runtime.getAvailableSnapshot().find((x) => x.provider === effProvider);
      if (fallback) return fallback;
      throw new Error(`KernelModelRouter: model ${effProvider}/${effModel} not found`);
    },
  };
}
