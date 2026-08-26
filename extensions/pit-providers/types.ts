/**
 * pit-providers — 类型定义
 *
 * ProviderDef / ModelDef 映射 providers.json schema。
 * 规则以跨仓 contract 为准：
 *   pi-triple-pth/docs/pth/contract/provider-config-contract.md
 * KeyPool 逻辑从 ustc-llm 提取，语义不变。
 */

// ─── Provider 声明 ──────────────────────────────────────────

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCompat {
  /** thinkingFormat: "deepseek" | "qwen" | "gemini" 等 */
  thinkingFormat?: string;
  supportsReasoningEffort?: boolean;
  [key: string]: unknown;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** model id 无格式限制（现存含空格/斜杠/大写） */
export interface ModelDef {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelCost;
  contextWindow?: number;
  maxTokens?: number;
  compat?: ModelCompat;
  /** 七键映射：off/minimal/low/medium/high/xhigh/max → 发送给 API 的 thinking 值或 null（不发送） */
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface InferRule {
  pattern: string; // regex literal（匹配 model id）
  /** 命中时合并的字段 */
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: Partial<ModelCost>;
  input?: string[];
  compat?: ModelCompat;
}

export interface InferDefaults extends Omit<ModelDef, "id" | "name"> {}

export interface ProviderCompat {
  supportsDeveloperRole?: boolean;
  supportsStore?: boolean;
  [key: string]: unknown;
}

export interface ProviderDef {
  /** 注册 id，^[a-z0-9-]+$ */
  id: string;
  /** 显示名 */
  name: string;
  /** /keys 命令匹配的别名（兼容现有肌肉记忆） */
  alias?: string[];
  baseUrl: string;
  api: "openai-completions" | string;
  /** 单 Key 的环境变量名（multiKey 时作空池兜底） */
  apiKeyEnv?: string;
  multiKey: boolean;
  /** provider 级 compat */
  compat?: ProviderCompat;
  /** 静态模型列表（refreshModels 动态合并时的 SPECS 查找表源） */
  models: ModelDef[];
  /** 是否调用 {baseUrl}/models 动态拉取 */
  refreshModels: boolean;
  /** 动态模型的 id 推断规则（全匹配合并） */
  inferRules?: InferRule[];
  /** 推断默认值 */
  inferDefaults?: InferDefaults;
}

// ─── Key 池（从 ustc-llm 提取，语义兼容） ────────────────

export interface KeyEntry {
  id: string;
  alias: string;
  /** API key 明文（存储在 PI_CODING_AGENT_DIR/auth.json 中） */
  key: string;
  failed: boolean;
}

export interface KeyPool {
  keys: KeyEntry[];
  activeId: string;
}
