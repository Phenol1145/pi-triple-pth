import { createHash } from "node:crypto";
import { isWorkMode, type WorkMode } from "@away_from/shared";

// ─── 页面 ID（固定五页，顺序即侧边栏顺序） ───

export const OPERATOR_PAGE_IDS = Object.freeze([
  "overview",
  "work",
  "debug",
  "memory",
  "config",
] as const);
export type OperatorPageId = (typeof OPERATOR_PAGE_IDS)[number];

export function isOperatorPageId(value: unknown): value is OperatorPageId {
  return (
    typeof value === "string" &&
    (OPERATOR_PAGE_IDS as readonly string[]).includes(value)
  );
}

// ─── 命令预览与原生引用（JSON 协议 DTO） ───

export type OperatorRisk = "low" | "medium" | "high";
export const OPERATOR_RISKS: readonly OperatorRisk[] = Object.freeze([
  "low",
  "medium",
  "high",
]);

export interface OperatorImpact {
  readonly scope: string;
  readonly reversible: boolean;
  readonly risk: OperatorRisk;
}

/** 服务端构造的操作上下文；csrfToken/sessionToken 允许存在但绝不进入 preview digest。 */
export interface OperatorContext {
  readonly tenant: string;
  readonly space: string;
  readonly csrfToken?: string;
  readonly sessionToken?: string;
}

export interface OperatorFormField {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "enum" | "object" | "array";
  readonly required: boolean;
  readonly description?: string;
  readonly schema?: Readonly<Record<string, unknown>>;
}

export interface OperatorFormDescriptor {
  readonly title: string;
  readonly description?: string;
  readonly fields: readonly OperatorFormField[];
}

export interface OperatorCommandPreview {
  readonly previewId: string;
  readonly mode: WorkMode;
  readonly action: string;
  readonly normalizedInput: Readonly<Record<string, unknown>>;
  readonly summary: readonly string[];
  readonly impact: OperatorImpact;
  readonly nativeTarget: string;
  readonly previewDigest: string;
  readonly expiresAt: string;
  readonly confirmation: "required";
}

export type NativeWorkKind =
  | "task"
  | "professional-job"
  | "intake-run"
  | "optimizer-work";

export interface NativeWorkRef {
  readonly mode: WorkMode;
  readonly kind: NativeWorkKind;
  readonly id: string;
  readonly tenantId: string;
  readonly submittedAt: string;
}

export interface NativeWorkProjection {
  readonly ref: NativeWorkRef;
  readonly status: string;
  readonly observedAt: string;
}

export interface OperatorAcceptanceProjection {
  readonly ref: NativeWorkRef;
  readonly accepted: boolean;
  readonly evidence: Readonly<Record<string, unknown>>;
}

// ─── 控制适配器（登记的控制面唯一入口） ───

export interface OperatorModeAdapter<TInput = unknown> {
  readonly mode: WorkMode;
  readonly action: string;
  describe(): OperatorFormDescriptor;
  preview(input: TInput, context: OperatorContext): Promise<OperatorCommandPreview>;
  submit(
    preview: OperatorCommandPreview,
    context: OperatorContext,
    /** N33 复验收 P0-4：由 preview-store 传入的幂等键；原生边界必须复用该键。 */
    idempotencyKey?: string,
  ): Promise<NativeWorkRef>;
  inspect(
    ref: NativeWorkRef,
    context: OperatorContext,
  ): Promise<NativeWorkProjection>;
  evaluate(
    ref: NativeWorkRef,
    context: OperatorContext,
  ): Promise<OperatorAcceptanceProjection>;
}

// ─── Canonical preview digest 输入与校验 ───

/**
 * 参与 canonical digest 的字段；display label（summary、title 等）与
 * CSRF/session token 不进入字节流。顶层字段固定顺序由 canonicalPreviewDigest 构造。
 */
export interface OperatorPreviewCanonicalInput {
  readonly mode: WorkMode;
  readonly action: string;
  readonly normalizedInput: Readonly<Record<string, unknown>>;
  readonly nativeTarget: string;
  readonly impact: OperatorImpact;
  readonly expiresAt: string;
}

export const OPERATOR_CANONICAL_PREVIEW_FIELDS = Object.freeze([
  "mode",
  "action",
  "normalizedInput",
  "nativeTarget",
  "impact",
  "expiresAt",
] as const);
export type OperatorPreviewCanonicalField =
  (typeof OPERATOR_CANONICAL_PREVIEW_FIELDS)[number];

/** context 只允许这些顶层字段；csrfToken/sessionToken 被校验但被 digest 排除。 */
export const OPERATOR_CONTEXT_FIELDS = Object.freeze([
  "tenant",
  "space",
  "csrfToken",
  "sessionToken",
] as const);

const NON_EMPTY_STRING = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertKnownTopLevelFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`unknown top-level field "${key}" on ${what}`);
    }
  }
}

function assertOperatorImpact(value: unknown): asserts value is OperatorImpact {
  if (!isPlainObject(value)) {
    throw new Error("impact must be a plain object");
  }
  assertKnownTopLevelFields(value, ["scope", "reversible", "risk"], "impact");
  if (!NON_EMPTY_STRING(value.scope)) {
    throw new Error("impact.scope must be a non-empty string");
  }
  if (typeof value.reversible !== "boolean") {
    throw new Error("impact.reversible must be a boolean");
  }
  if (
    typeof value.risk !== "string" ||
    !(OPERATOR_RISKS as readonly string[]).includes(value.risk)
  ) {
    throw new Error("impact.risk must be one of low, medium, high");
  }
}

export function assertOperatorContext(value: unknown): asserts value is OperatorContext {
  if (!isPlainObject(value)) {
    throw new Error("operator context must be a plain object");
  }
  assertKnownTopLevelFields(value, OPERATOR_CONTEXT_FIELDS, "operator context");
  if (!NON_EMPTY_STRING(value.tenant)) {
    throw new Error("operator context tenant must be a non-empty string");
  }
  if (!NON_EMPTY_STRING(value.space)) {
    throw new Error("operator context space must be a non-empty string");
  }
  if (value.csrfToken !== undefined && typeof value.csrfToken !== "string") {
    throw new Error("operator context csrfToken must be a string");
  }
  if (value.sessionToken !== undefined && typeof value.sessionToken !== "string") {
    throw new Error("operator context sessionToken must be a string");
  }
}

export function assertOperatorPreviewCanonicalInput(
  value: unknown,
): asserts value is OperatorPreviewCanonicalInput {
  if (!isPlainObject(value)) {
    throw new Error("operator preview canonical input must be a plain object");
  }
  assertKnownTopLevelFields(
    value,
    OPERATOR_CANONICAL_PREVIEW_FIELDS,
    "operator preview canonical input",
  );
  if (!isWorkMode(value.mode)) {
    throw new Error(`unknown work mode: ${String(value.mode)}`);
  }
  if (!NON_EMPTY_STRING(value.action)) {
    throw new Error("action must be a non-empty string");
  }
  if (!isPlainObject(value.normalizedInput)) {
    throw new Error("normalizedInput must be a plain object");
  }
  if (!NON_EMPTY_STRING(value.nativeTarget)) {
    throw new Error("nativeTarget must be a non-empty string");
  }
  assertOperatorImpact(value.impact);
  if (!NON_EMPTY_STRING(value.expiresAt)) {
    throw new Error("expiresAt must be a non-empty string");
  }
  assertCanonicalJsonValue(value, "preview");
}

/** 递归拒绝 non-finite number、function/symbol/bigint 与非 plain prototype。 */
export function assertCanonicalJsonValue(value: unknown, path = "value"): void {
  if (value === null) return;
  if (value === undefined) {
    throw new Error(`undefined is not allowed in canonical JSON at ${path}`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `non-finite number is not allowed in canonical preview bytes at ${path}`,
      );
    }
    return;
  }
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "function") {
    throw new Error(
      `functions are not allowed in canonical preview bytes at ${path}`,
    );
  }
  if (typeof value === "symbol") {
    throw new Error(`symbols are not allowed in canonical preview bytes at ${path}`);
  }
  if (typeof value === "bigint") {
    throw new Error(`bigints are not allowed in canonical preview bytes at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertCanonicalJsonValue(item, `${path}[${index}]`);
    });
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertCanonicalJsonValue(item, `${path}.${key}`);
    }
    return;
  }
  throw new Error(
    `non-plain object prototype is not allowed in canonical preview bytes at ${path}`,
  );
}

// ─── 确定性序列化（顶层固定顺序，嵌套键排序） ───

function serializeCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(record[key])}`)
    .join(",")}}`;
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(serializeCanonicalJson(value), "utf8");
}

/**
 * Canonical preview digest：字节流只含 mode、action、normalizedInput、nativeTarget、
 * impact、tenant、space、expiresAt（按此固定顺序）。summary/title 等显示标签与
 * csrfToken/sessionToken 一律排除；任何 non-finite number、function、非 plain
 * prototype 或未知顶层字段都会抛错，而不是被静默忽略。
 */
export function canonicalPreviewDigest(
  input: OperatorPreviewCanonicalInput,
  context: OperatorContext,
): string {
  assertOperatorPreviewCanonicalInput(input);
  assertOperatorContext(context);

  const canonical: Record<string, unknown> = {
    mode: input.mode,
    action: input.action,
    normalizedInput: input.normalizedInput,
    nativeTarget: input.nativeTarget,
    impact: input.impact,
    tenant: context.tenant,
    space: context.space,
    expiresAt: input.expiresAt,
  };
  assertCanonicalJsonValue(canonical, "preview");
  return createHash("sha256").update(canonicalJsonBytes(canonical)).digest("hex");
}

// ─── 深拷贝 + 深冻结（不可变 DTO 防护） ───

function deepCopyJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepCopyJson(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = deepCopyJson(item);
    }
    return copy as unknown as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

/** 深拷贝并深冻结纯 JSON 值；调用方对象不被冻结或篡改。 */
export function deepFreezeJson<T>(value: T): Readonly<T> {
  assertCanonicalJsonValue(value, "value");
  return deepFreeze(deepCopyJson(value));
}
