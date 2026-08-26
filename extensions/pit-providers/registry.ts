/**
 * pit-providers — registry
 *
 * providers.json 加载、校验、首次生成。
 * 校验规则以跨仓 contract 为准：
 *   pi-triple-pth/docs/pth/contract/provider-config-contract.md
 * provider id 必须 ^[a-z0-9-]+$；model id 无格式限制但必须非空。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProviderDef, ModelDef } from "./types.js";

// ─── 路径 ────────────────────────────────────────────────────

/** providers.json 路径：默认 ~/.pi-triple/providers.json，可由 PI_TRIPLE_HOME 覆盖 */
export function providersPath(): string {
  const home = process.env.PI_TRIPLE_HOME ?? path.join(os.homedir(), ".pi-triple");
  return path.join(home, "providers.json");
}

// ─── 校验 ────────────────────────────────────────────────────

const PROVIDER_ID_RE = /^[a-z0-9-]+$/;

const REQUIRED_STR_KEYS = ["id", "name", "baseUrl", "api"] as const;
const REQUIRED_BOOL_KEYS = ["multiKey", "refreshModels"] as const;

export function validateProvider(
  raw: unknown,
): { ok: true; def: ProviderDef } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "provider 必须是对象" };
  }

  const obj = raw as Record<string, unknown>;

  // 必填非空字符串字段
  for (const key of REQUIRED_STR_KEYS) {
    if (typeof obj[key] !== "string" || (obj[key] as string).trim() === "") {
      return { ok: false, error: `provider.${key} 是必填非空字符串字段` };
    }
  }

  // id 格式验证
  if (!PROVIDER_ID_RE.test(obj.id as string)) {
    return { ok: false, error: `provider.id 必须匹配 ^[a-z0-9-]+$，收到: "${obj.id}"` };
  }

  // baseUrl 必须 http(s)（跨仓 contract：docs/pth/contract/provider-config-contract.md）
  if (typeof obj.baseUrl === "string" && !/^https?:\/\//i.test(obj.baseUrl)) {
    return { ok: false, error: `provider.baseUrl 必须 http(s)://，收到: "${obj.baseUrl}"` };
  }

  // 必填布尔字段
  for (const key of REQUIRED_BOOL_KEYS) {
    if (typeof obj[key] !== "boolean") {
      return { ok: false, error: `provider.${key} 是必填布尔字段` };
    }
  }

  // models 必须是数组
  if (!Array.isArray(obj.models)) {
    return { ok: false, error: `provider.models 必须是数组` };
  }

  // 校验每个 model（model id 无格式限制但必须非空——现存含空格/斜杠/大写）
  for (let i = 0; i < obj.models.length; i++) {
    const m = obj.models[i];
    if (typeof m !== "object" || m === null) {
      return { ok: false, error: `provider.models[${i}] 必须是对象` };
    }
    if (typeof (m as any).id !== "string" || (m as any).id.trim() === "") {
      return { ok: false, error: `provider.models[${i}].id 是必填非空字符串` };
    }
  }

  // alias 必须是非空字符串数组（元素逐个校验）
  if (obj.alias !== undefined) {
    if (!Array.isArray(obj.alias) || obj.alias.some((a) => typeof a !== "string" || a.trim() === "")) {
      return { ok: false, error: "provider.alias 必须是非空字符串数组" };
    }
  }

  // 保真：校验通过后保留完整原始对象，只做类型收窄，不丢弃未知字段。
  const def = raw as unknown as ProviderDef;

  return { ok: true, def };
}

// ─── 加载 ────────────────────────────────────────────────────

export function loadProviders(): { providers: ProviderDef[]; errors: string[] } {
  const p = providersPath();
  const errors: string[] = [];

  if (!fs.existsSync(p)) {
    return { providers: [], errors: [] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (err: any) {
    return { providers: [], errors: [`JSON 解析失败: ${err.message}`] };
  }

  if (typeof raw !== "object" || raw === null) {
    return { providers: [], errors: ["providers.json 顶层必须是对象"] };
  }

  const obj = raw as Record<string, unknown>;

  if (obj.version !== 1) {
    errors.push(`version 字段必须为 1，收到: ${obj.version}`);
  }

  if (!Array.isArray(obj.providers)) {
    errors.push("providers 字段必须是数组");
    return { providers: [], errors };
  }

  const providers: ProviderDef[] = [];
  const names = new Set<string>();

  for (let i = 0; i < obj.providers.length; i++) {
    const result = validateProvider(obj.providers[i]);
    if (!result.ok) {
      errors.push(`Providers[${i}]: ${result.error}`);
      continue;
    }
    const def = result.def;
    let conflict = false;
    for (const name of [def.id, ...(def.alias ?? [])]) {
      if (names.has(name)) {
        errors.push(`Providers[${i}]: id/alias "${name}" 与已有 id/alias 冲突`);
        conflict = true;
        break;
      }
      names.add(name);
    }
    if (!conflict) providers.push(def);
  }

  // strict mode：任一 contract error 都拒绝整个文件，避免调用方在半有效配置上运行。
  if (errors.length > 0) return { providers: [], errors };
  return { providers, errors };
}

// ─── 默认生成 ────────────────────────────────────────────────

/**
 * 内置默认 provider 定义。
 * 数据来源：kimi-platform/index.ts、ustc-llm/index.ts（SPECS / SUNTOMB_SPECS）。
 * 总计：kimi 4 + ustc 23 + suntomb 23 = 50 模型。
 */

/** Kimi 模型定义（从 kimi-platform/index.ts 完整提取，4 个模型） */
const KIMI_MODELS: ModelDef[] = [
  {
    id: "kimi-k3",
    name: "Kimi K3",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1048576,
    maxTokens: 131072,
    thinkingLevelMap: {
      off: null, minimal: null, low: "low",
      medium: null, high: "high", xhigh: null, max: "max",
    },
  },
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32768,
  },
  {
    id: "kimi-k2.7-code-highspeed",
    name: "Kimi K2.7 Code HighSpeed",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.9, output: 8.0, cacheRead: 0.38, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32768,
  },
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.0, output: 4.0, cacheRead: 0.2, cacheWrite: 1.25 },
    contextWindow: 262144,
    maxTokens: 32768,
  },
];

/** USTC LLM 模型定义（从 ustc-llm/index.ts SPECS 完整提取，23 个模型） */
const USTC_MODELS: ModelDef[] = [
  // === Claude (通过 OpenAI 兼容 API 代理) ===
  { id: "claude-opus-4-8", name: "Claude Opus 4.8 (USTC)", reasoning: true, input: ["text","image"], contextWindow: 1000000, maxTokens: 8192 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (USTC)", reasoning: true, input: ["text","image"], contextWindow: 1000000, maxTokens: 8192 },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5 (USTC)", reasoning: true, input: ["text","image"], contextWindow: 1000000, maxTokens: 8192 },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (USTC)", reasoning: true, input: ["text","image"], contextWindow: 1000000, maxTokens: 8192 },
  // === DeepSeek ===
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro (USTC)", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 8192, compat: { thinkingFormat: "deepseek" } },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (USTC)", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 },
  { id: "deepseek-v4-flash-ascend", name: "DeepSeek V4 Flash Ascend (USTC)", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 },
  { id: "deepseek-v4-flash-ascend1", name: "DeepSeek V4 Flash Ascend1 (USTC)", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 },
  { id: "deepseek-reasoner", name: "DeepSeek Reasoner (USTC)", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 8192, compat: { thinkingFormat: "deepseek" } },
  { id: "deepseek-chat", name: "DeepSeek Chat (USTC)", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 },
  // === Qwen ===
  { id: "qwen3.6-chat", name: "Qwen3.6 Chat (USTC)", reasoning: false, input: ["text","image"], contextWindow: 128000, maxTokens: 8192 },
  { id: "qwen3.6-reasoner", name: "Qwen3.6 Reasoner (USTC)", reasoning: true, input: ["text","image"], contextWindow: 128000, maxTokens: 8192, compat: { thinkingFormat: "qwen", supportsDeveloperRole: false } },
  { id: "qwen3.5", name: "Qwen3.5 (USTC)", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192 },
  { id: "qwen3.5-thinking", name: "Qwen3.5 Thinking (USTC)", reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 8192, compat: { thinkingFormat: "qwen", supportsDeveloperRole: false } },
  { id: "qwen3.5-non-thinking", name: "Qwen3.5 Non-Thinking (USTC)", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192 },
  { id: "qwen-chat", name: "Qwen Chat (USTC)", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192 },
  { id: "qwen-reasoner", name: "Qwen Reasoner (USTC)", reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 8192, compat: { thinkingFormat: "qwen", supportsDeveloperRole: false } },
  // === GLM ===
  { id: "glm-chat", name: "GLM Chat (USTC)", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 4096 },
  { id: "glm-reasoner", name: "GLM Reasoner (USTC)", reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 4096 },
  { id: "glm-5.2", name: "GLM 5.2 (USTC)", reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 4096 },
  { id: "glm-5.2-107", name: "GLM 5.2 107 (USTC)", reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 4096 },
  // === Smart 路由 ===
  { id: "smart/default", name: "Smart Default (USTC)", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192 },
  { id: "smart/reasoning", name: "Smart Reasoning (USTC)", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 8192 },
];

/** Suntomb thinkingLevelMap 常量（从 ustc-llm/index.ts 解析 spread 运算符） */
const TLM_OPENAI_XHIGH: Record<string, string | null> = {
  off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null,
};
const TLM_OPENAI_MAX: Record<string, string | null> = {
  off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
};
const TLM_CLAUDE_MAX: Record<string, string | null> = {
  off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: "max",
};
const TLM_CLAUDE_STD: Record<string, string | null> = {
  off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null,
};
const TLM_FIX_LOW: Record<string, string | null> = {
  off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null,
};
const TLM_FIX_MED: Record<string, string | null> = {
  off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null,
};
const TLM_FIX_HIGH: Record<string, string | null> = {
  off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null,
};

/** Suntomb 模型定义（从 ustc-llm/index.ts SUNTOMB_SPECS 完整提取，23 个模型） */
const SUNTOMB_MODELS: ModelDef[] = [
  // === kiro (Claude 代理, 外接倍率 ×1) ===
  { id: "kiro/claude-opus-4-8", name: "Claude Opus 4.8 (Suntomb)", reasoning: true, thinkingLevelMap: TLM_OPENAI_MAX, input: ["text","image"], contextWindow: 1000000, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true }, cost: { input: 5.00, cacheRead: 0.50, output: 25.00 } },
  { id: "kiro/claude-opus-4-7", name: "Claude Opus 4.7 (Suntomb)", reasoning: true, thinkingLevelMap: TLM_OPENAI_MAX, input: ["text","image"], contextWindow: 1000000, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true }, cost: { input: 5.00, cacheRead: 0.50, output: 25.00 } },
  { id: "kiro/claude-opus-4-6", name: "Claude Opus 4.6 (Suntomb)", reasoning: true, thinkingLevelMap: TLM_CLAUDE_MAX, input: ["text","image"], contextWindow: 1000000, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true }, cost: { input: 5.00, cacheRead: 0.50, output: 25.00 } },
  { id: "kiro/claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Suntomb)", reasoning: true, thinkingLevelMap: TLM_CLAUDE_MAX, input: ["text","image"], contextWindow: 1000000, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true }, cost: { input: 3.00, cacheRead: 0.30, output: 15.00 } },
  { id: "kiro/claude-sonnet-4-5", name: "Claude Sonnet 4.5 (Suntomb)", reasoning: true, thinkingLevelMap: TLM_CLAUDE_STD, input: ["text","image"], contextWindow: 200000, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true }, cost: { input: 3.00, cacheRead: 0.30, output: 15.00 } },
  { id: "kiro/claude-sonnet-4", name: "Claude Sonnet 4 (Suntomb)", reasoning: true, thinkingLevelMap: TLM_CLAUDE_STD, input: ["text","image"], contextWindow: 200000, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true }, cost: { input: 3.00, cacheRead: 0.30, output: 15.00 } },
  { id: "kiro/claude-haiku-4-5", name: "Claude Haiku 4.5 (Suntomb)", reasoning: true, thinkingLevelMap: TLM_CLAUDE_STD, input: ["text"], contextWindow: 200000, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: true }, cost: { input: 1.00, cacheRead: 0.10, output: 5.00 } },
  // === plus (OpenAI GPT 代理, 外接倍率 ×0.5) ===
  { id: "plus/gpt-5.5", name: "GPT-5.5 (Suntomb)", reasoning: true, thinkingLevelMap: TLM_OPENAI_XHIGH, input: ["text"], contextWindow: 1048576, maxTokens: 8192, compat: { supportsReasoningEffort: true }, cost: { input: 2.50, cacheRead: 0.25, output: 15.00 } },
  { id: "plus/gpt-5.4", name: "GPT-5.4 (Suntomb)", reasoning: true, thinkingLevelMap: TLM_OPENAI_XHIGH, input: ["text"], contextWindow: 1048576, maxTokens: 8192, compat: { supportsReasoningEffort: true }, cost: { input: 1.25, cacheRead: 0.125, output: 7.50 } },
  { id: "plus/gpt-5.4-mini", name: "GPT-5.4 Mini (Suntomb)", reasoning: true, thinkingLevelMap: TLM_OPENAI_XHIGH, input: ["text"], contextWindow: 1048576, maxTokens: 8192, compat: { supportsReasoningEffort: true }, cost: { input: 0.375, cacheRead: 0.0375, output: 2.25 } },
  { id: "plus/gpt-5.6-terra", name: "GPT-5.6 Terra (Suntomb)", reasoning: true, thinkingLevelMap: TLM_OPENAI_MAX, input: ["text"], contextWindow: 1048576, maxTokens: 8192, compat: { supportsReasoningEffort: true }, cost: { input: 1.25, cacheRead: 0.125, output: 7.50 } },
  { id: "plus/gpt-5.6-luna", name: "GPT-5.6 Luna (Suntomb)", reasoning: true, thinkingLevelMap: TLM_OPENAI_MAX, input: ["text"], contextWindow: 1048576, maxTokens: 8192, compat: { supportsReasoningEffort: true }, cost: { input: 0.50, cacheRead: 0.05, output: 3.00 } },
  { id: "plus/gpt-5.6-sol", name: "GPT-5.6 Sol (Suntomb)", reasoning: true, thinkingLevelMap: TLM_OPENAI_MAX, input: ["text"], contextWindow: 1048576, maxTokens: 8192, compat: { supportsReasoningEffort: true }, cost: { input: 2.50, cacheRead: 0.25, output: 15.00 } },
  // === Gemini (Antigravity 代理, 外接倍率 ×0.5) ===
  { id: "Gemini 3.5 Flash (Low)", name: "Gemini 3.5 Flash Low (Suntomb)", reasoning: true, thinkingLevelMap: TLM_FIX_LOW, input: ["text","image"], contextWindow: 1048576, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, cost: { input: 0.75, cacheRead: 0.075, output: 4.50 } },
  { id: "Gemini 3.5 Flash (Medium)", name: "Gemini 3.5 Flash Med (Suntomb)", reasoning: true, thinkingLevelMap: TLM_FIX_MED, input: ["text","image"], contextWindow: 1048576, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, cost: { input: 1.00, cacheRead: 0.10, output: 6.00 } },
  { id: "Gemini 3.5 Flash (High)", name: "Gemini 3.5 Flash High (Suntomb)", reasoning: true, thinkingLevelMap: TLM_FIX_HIGH, input: ["text","image"], contextWindow: 1048576, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, cost: { input: 1.50, cacheRead: 0.15, output: 9.00 } },
  { id: "Gemini 3.6 Flash (Low)", name: "Gemini 3.6 Flash Low (Suntomb)", reasoning: true, thinkingLevelMap: TLM_FIX_LOW, input: ["text","image"], contextWindow: 1048576, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, cost: { input: 0.75, cacheRead: 0.075, output: 4.50 } },
  { id: "Gemini 3.6 Flash (Medium)", name: "Gemini 3.6 Flash Med (Suntomb)", reasoning: true, thinkingLevelMap: TLM_FIX_MED, input: ["text","image"], contextWindow: 1048576, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, cost: { input: 1.00, cacheRead: 0.10, output: 6.00 } },
  { id: "Gemini 3.6 Flash (High)", name: "Gemini 3.6 Flash High (Suntomb)", reasoning: true, thinkingLevelMap: TLM_FIX_HIGH, input: ["text","image"], contextWindow: 1048576, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, cost: { input: 1.50, cacheRead: 0.15, output: 9.00 } },
  { id: "Gemini 3.1 Pro (Low)", name: "Gemini 3.1 Pro Low (Suntomb)", reasoning: true, thinkingLevelMap: TLM_FIX_LOW, input: ["text","image"], contextWindow: 1048576, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, cost: { input: 1.00, cacheRead: 0.10, output: 6.00 } },
  { id: "Gemini 3.1 Pro (High)", name: "Gemini 3.1 Pro High (Suntomb)", reasoning: true, thinkingLevelMap: TLM_FIX_HIGH, input: ["text","image"], contextWindow: 1048576, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, cost: { input: 2.00, cacheRead: 0.20, output: 12.00 } },
  // === Anthropic 官方 (Thinking 模型) ===
  { id: "Claude Sonnet 4.6 (Thinking)", name: "Claude Sonnet 4.6 Thinking (Suntomb)", reasoning: true, thinkingLevelMap: TLM_FIX_HIGH, input: ["text","image"], contextWindow: 1000000, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, cost: { input: 3.00, cacheRead: 0.30, output: 15.00 } },
  { id: "Claude Opus 4.6 (Thinking)", name: "Claude Opus 4.6 Thinking (Suntomb)", reasoning: true, thinkingLevelMap: TLM_FIX_HIGH, input: ["text","image"], contextWindow: 1000000, maxTokens: 8192, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, cost: { input: 5.00, cacheRead: 0.50, output: 25.00 } },
];

/** 内置默认 provider 定义 */
function builtinDefaults(): ProviderDef[] {
  return [
    {
      id: "kimi",
      name: "Kimi",
      alias: ["moonshot"],
      baseUrl: "https://api.moonshot.cn/v1",
      api: "openai-completions",
      apiKeyEnv: "KIMI_API_KEY",
      multiKey: false,
      compat: { supportsDeveloperRole: false, supportsStore: false },
      models: KIMI_MODELS,
      refreshModels: false,
    },
    {
      id: "ustc-llm",
      name: "USTC LLM",
      alias: ["ustc"],
      baseUrl: "https://api.llm.ustc.edu.cn/v1",
      api: "openai-completions",
      apiKeyEnv: "USTC_LLM_API_KEY",
      multiKey: true,
      models: USTC_MODELS,
      refreshModels: true,
      inferRules: [
        { pattern: "gemini", contextWindow: 1048576, input: ["text", "image"] },
        { pattern: "claude", contextWindow: 1000000, input: ["text", "image"] },
        { pattern: "gpt", contextWindow: 1048576 },
        { pattern: "vision|image", input: ["text", "image"] },
      ],
      inferDefaults: {
        contextWindow: 128000,
        maxTokens: 8192,
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    },
    {
      id: "suntomb",
      name: "Suntomb LLM",
      alias: ["suntomb-llm"],
      baseUrl: "https://server.suntomb.qzz.io/v1",
      api: "openai-completions",
      apiKeyEnv: "SUNTOMB_API_KEY",
      multiKey: true,
      models: SUNTOMB_MODELS,
      refreshModels: true,
    },
  ];
}

/** 文件不存在时写入内置默认。返回 true 表示已创建。 */
export function ensureDefaultProviders(filePath?: string): boolean {
  const p = filePath ?? providersPath();
  if (fs.existsSync(p)) return false;

  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });

  const doc = {
    version: 1,
    providers: builtinDefaults(),
  };

  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  return true;
}
