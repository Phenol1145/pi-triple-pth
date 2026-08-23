/**
 * contracts/execution-target.ts — ExecutionTarget 标准化定义（Execution Target Matrix）。
 *
 * 目标：把 sandbox / local / tool / jupyter / engine-ts 等执行组件统一描述为
 * `ExecutionTargetDefinition`，供 NotebookTargetRouter 与未来执行面统一使用。
 *
 * 依赖边界：本文件只依赖 `@away_from/shared/execution` 的类型与校验函数，
 * 不 import 任何运行时实现（fastify / pg / sandbox）。
 */

import type { ExecutionModes, ExecutionProfile } from "@away_from/shared/execution";
import { isExecutionProfile } from "@away_from/shared/execution";

/** notebook 可执行语言（可扩展："c"、"lean"…） */
export type NotebookLanguage = "python" | "bash" | "ts";

/** ExecutionTarget 实现形态 */
export type ExecutionTargetKind =
  | "kernel-pool"        // 持久 REPL 池（sandbox python/bash）
  | "command"            // 一次性命令执行（local/tool/jupyter）
  | "engine-internal";   // engine 进程内解释器（ts）

/** 会话模型 */
export type SessionModel =
  | { readonly type: "persistent-repl"; readonly scope: "notebook"; readonly ttlMs?: number }
  | { readonly type: "one-shot" }     // 每 cell 独立
  | { readonly type: "none" };

/** ExecutionTarget 能力（富媒体字段为后续 MIME bundle 预留） */
export interface ExecutionTargetCapabilities {
  readonly richMedia: boolean;        // 是否可产出 mimeBundle
  readonly streaming: boolean;
  readonly cancel: boolean;
  readonly pathMapping: boolean;
  readonly maxOutputBytes?: number;
}

/** 路由策略 */
export interface ExecutionTargetRoutingPolicy {
  /** 该 ExecutionTarget 是哪些语言的默认执行组件 */
  readonly defaultFor: NotebookLanguage[];
  /** 是否允许 cell magic 显式选择 */
  readonly userSelectable: boolean;
  /** 是否需要用户显式批准后才能使用（如 local/tool） */
  readonly requiresApproval: boolean;
}

/** engine 如何触达该 ExecutionTarget（判别联合） */
export type ExecutionTargetBinding =
  | { readonly type: "execution-backend"; readonly backendId: string; readonly mode: "sync" | "stream" }
  | { readonly type: "execution-session"; readonly backendId: string }      // persistent /sessions
  | { readonly type: "engine-internal"; readonly interpreter: "ts" };

/** 信任档：复用共享 ExecutionProfile，扩展 "engine" 内部分类（不下发 execution/v1.1） */
export type ExecutionTargetProfile = ExecutionProfile | "engine";

/** 标准化 ExecutionTarget 定义（每个执行组件一份） */
export interface ExecutionTargetDefinition {
  /** engine 内唯一 id，^[a-z][a-z0-9._-]{0,63}$ */
  readonly id: string;
  readonly kind: ExecutionTargetKind;
  /** 信任档；engine-internal 用 "engine" */
  readonly profile: ExecutionTargetProfile;
  readonly description?: string;
  /** 支持的语言 */
  readonly languages: NotebookLanguage[];
  /** execution/v1.1 模式位图（复用现有类型） */
  readonly modes: ExecutionModes;
  readonly session: SessionModel;
  readonly capabilities: ExecutionTargetCapabilities;
  readonly routing: ExecutionTargetRoutingPolicy;
  readonly binding: ExecutionTargetBinding;
}

/** Router 只依赖该只读接口，不依赖 src/pth 实现（由装配层注入） */
export interface ExecutionTargetRegistry {
  get(id: string): ExecutionTargetDefinition | undefined;
  list(): ReadonlyMap<string, ExecutionTargetDefinition>;
  /** 按语言/显式 target 解析；非法或未批准时抛结构化错误 */
  resolve(language: NotebookLanguage, target?: string | null): ExecutionTargetDefinition;
}

// ── 结构校验（fail-closed；布尔风格 + 抛错包装） ──────────────────────

const NOTEBOOK_LANGUAGES: readonly string[] = ["python", "bash", "ts"];
const EXECUTION_TARGET_KINDS: readonly string[] = ["kernel-pool", "command", "engine-internal"];
const TARGET_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;

function isNotebookLanguage(v: unknown): v is NotebookLanguage {
  return typeof v === "string" && NOTEBOOK_LANGUAGES.includes(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isSessionModelStructurallyValid(v: unknown): v is SessionModel {
  if (!isRecord(v)) return false;
  if (v.type === "persistent-repl") {
    if (v.scope !== "notebook") return false;
    if (v.ttlMs !== undefined && (typeof v.ttlMs !== "number" || !Number.isFinite(v.ttlMs) || v.ttlMs <= 0)) return false;
    return true;
  }
  return v.type === "one-shot" || v.type === "none";
}

function isExecutionTargetCapabilitiesStructurallyValid(v: unknown): v is ExecutionTargetCapabilities {
  if (!isRecord(v)) return false;
  if (!isBoolean(v.richMedia) || !isBoolean(v.streaming) || !isBoolean(v.cancel) || !isBoolean(v.pathMapping)) return false;
  if (v.maxOutputBytes !== undefined && (typeof v.maxOutputBytes !== "number" || !Number.isFinite(v.maxOutputBytes) || v.maxOutputBytes <= 0)) return false;
  return true;
}

function isExecutionTargetRoutingPolicyStructurallyValid(v: unknown): v is ExecutionTargetRoutingPolicy {
  if (!isRecord(v)) return false;
  if (!isBoolean(v.userSelectable) || !isBoolean(v.requiresApproval)) return false;
  if (!Array.isArray(v.defaultFor) || !v.defaultFor.every(isNotebookLanguage)) return false;
  return true;
}

function isExecutionTargetBindingStructurallyValid(v: unknown): v is ExecutionTargetBinding {
  if (!isRecord(v)) return false;
  if (v.type === "execution-backend") {
    return typeof v.backendId === "string" && v.backendId.trim() !== "" && (v.mode === "sync" || v.mode === "stream");
  }
  if (v.type === "execution-session") {
    return typeof v.backendId === "string" && v.backendId.trim() !== "";
  }
  if (v.type === "engine-internal") {
    return v.interpreter === "ts";
  }
  return false;
}

export function isExecutionTargetDefinitionStructurallyValid(v: unknown): v is ExecutionTargetDefinition {
  if (!isRecord(v)) return false;
  if (typeof v.id !== "string" || !TARGET_ID_RE.test(v.id)) return false;
  if (typeof v.kind !== "string" || !EXECUTION_TARGET_KINDS.includes(v.kind)) return false;
  if (typeof v.profile !== "string" || (v.profile !== "engine" && !isExecutionProfile(v.profile))) return false;
  if (!Array.isArray(v.languages) || v.languages.length === 0 || !v.languages.every(isNotebookLanguage)) return false;
  if (!isRecord(v.modes)) return false;
  const modes = v.modes as Record<string, unknown>;
  if (!isBoolean(modes.sync) || !isBoolean(modes.stream) || !isBoolean(modes.interactive) || !isBoolean(modes.persistent)) return false;
  if (!isSessionModelStructurallyValid(v.session)) return false;
  if (!isExecutionTargetCapabilitiesStructurallyValid(v.capabilities)) return false;
  if (!isExecutionTargetRoutingPolicyStructurallyValid(v.routing)) return false;
  if (!isExecutionTargetBindingStructurallyValid(v.binding)) return false;
  return true;
}

/** 注册表矩阵校验：重复 id / 非法 language / binding.backendId 未注册 → 抛错（fail-closed）。 */
export function validateExecutionTargetMatrix(
  targets: readonly ExecutionTargetDefinition[],
  opts?: { registeredBackendIds?: ReadonlySet<string> },
): void {
  const seen = new Set<string>();
  for (const target of targets) {
    if (!isExecutionTargetDefinitionStructurallyValid(target)) {
      throw new Error(`ExecutionTarget 结构非法: ${JSON.stringify(target)}`);
    }
    if (seen.has(target.id)) {
      throw new Error(`ExecutionTarget 重复 id: ${target.id}`);
    }
    seen.add(target.id);
    if (target.binding.type === "execution-backend" || target.binding.type === "execution-session") {
      const backendIds = opts?.registeredBackendIds;
      if (backendIds && !backendIds.has(target.binding.backendId)) {
        throw new Error(`ExecutionTarget ${target.id} binding.backendId 未注册: ${target.binding.backendId}`);
      }
    }
    for (const lang of target.languages) {
      if (!isNotebookLanguage(lang)) {
        throw new Error(`ExecutionTarget ${target.id} 含非法 language: ${String(lang)}`);
      }
    }
  }
}
