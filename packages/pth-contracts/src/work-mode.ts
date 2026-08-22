/**
 * contracts/work-mode.ts — M0 三种 Work Mode 的服务端盖章契约（纯类型 + 结构校验）。
 *
 * Mode 只表达“为什么工作”（intake / optimize / run），可以并发；它不替代
 * Task/Intake 的原生状态机，也不等于 Role 或 Workflow。每个有限工作项只有一个
 * 服务端盖章的 WorkMode；Mode 不能原地改变——跨模式必须创建新的 workId 与 WorkEnvelope。
 *
 * 本文件不暴露任何 body → envelope 解析器：envelope 只能由服务端代码构造。
 */

export const WORK_MODES = ["intake", "optimize", "run"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export interface WorkEnvelope {
  workId: string;
  mode: WorkMode;
  objective: string;
  authorityPolicyRef: string;
  budgetPolicyRef: string;
  parentWorkId?: string;
  causationId: string;
}

const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export function isWorkMode(v: unknown): v is WorkMode {
  return typeof v === "string" && (WORK_MODES as readonly string[]).includes(v);
}

/** 服务端构造 WorkEnvelope。拒绝未知 mode、空 policy、自父引用与缺失 causation。 */
export function createServerWorkEnvelope(input: {
  workId: string;
  mode: WorkMode;
  objective: string;
  authorityPolicyRef: string;
  budgetPolicyRef: string;
  parentWorkId?: string;
  causationId: string;
}): WorkEnvelope {
  if (!NON_EMPTY_STRING(input.workId)) {
    throw new Error("workId is required");
  }
  if (!isWorkMode(input.mode)) {
    throw new Error(`unknown work mode: ${String(input.mode)}`);
  }
  if (!NON_EMPTY_STRING(input.objective)) {
    throw new Error("objective is required");
  }
  if (!NON_EMPTY_STRING(input.authorityPolicyRef)) {
    throw new Error("authorityPolicyRef is required");
  }
  if (!NON_EMPTY_STRING(input.budgetPolicyRef)) {
    throw new Error("budgetPolicyRef is required");
  }
  if (input.parentWorkId !== undefined) {
    if (!NON_EMPTY_STRING(input.parentWorkId)) {
      throw new Error("parentWorkId cannot be empty");
    }
    if (input.parentWorkId === input.workId) {
      throw new Error("self-parenting is not allowed");
    }
  }
  if (!NON_EMPTY_STRING(input.causationId)) {
    throw new Error("causationId is required");
  }
  return {
    workId: input.workId,
    mode: input.mode,
    objective: input.objective,
    authorityPolicyRef: input.authorityPolicyRef,
    budgetPolicyRef: input.budgetPolicyRef,
    ...(input.parentWorkId !== undefined ? { parentWorkId: input.parentWorkId } : {}),
    causationId: input.causationId,
  };
}

/** Mode 不可原地改变：同 workId 改 mode 必须拒绝（跨模式必须创建新 workId）。 */
export function assertWorkModeImmutable(
  before: Pick<WorkEnvelope, "workId" | "mode">,
  after: Pick<WorkEnvelope, "workId" | "mode">,
): void {
  if (before.workId === after.workId && before.mode !== after.mode) {
    throw new Error("cross-mode work requires a new work id");
  }
}

// ─── 跨模式创建：只允许四条固定 handoff，且永远新建 workId + causation ───

export const CROSS_MODE_HANDOFFS: Readonly<Record<WorkMode, readonly WorkMode[]>> = Object.freeze({
  run: Object.freeze(["intake", "optimize"] as const),
  intake: Object.freeze(["optimize"] as const),
  optimize: Object.freeze(["intake"] as const),
});

export function isAllowedCrossModeHandoff(from: WorkMode, to: WorkMode): boolean {
  return (CROSS_MODE_HANDOFFS[from] as readonly WorkMode[]).includes(to);
}

export interface CrossModeWorkRequest {
  readonly fromWorkId: string;
  readonly fromMode: WorkMode;
  readonly toMode: WorkMode;
  readonly objective: string;
  readonly authorityPolicyRef: string;
  readonly budgetPolicyRef: string;
  readonly causationId: string;
}

export interface CrossModeWorkPublishInput {
  readonly workMode: WorkMode;
  readonly objective: string;
  readonly authorityPolicyRef: string;
  readonly budgetPolicyRef: string;
  readonly parentWorkId: string;
  readonly causationId: string;
}

export interface CrossModeWorkPublisher {
  publish(input: CrossModeWorkPublishInput): Promise<{ workId: string }>;
}

export interface CrossModeWorkResult {
  workId: string;
  workMode: WorkMode;
  parentWorkId: string;
  causationId: string;
}

/**
 * 跨模式必须创建新 work：校验四条固定 handoff、拒绝同 mode 重入，并通过注入的
 * publisher 发布新任务（contracts 层不 import pg/fastify 等运行时实现）。
 */
export async function createCrossModeWork(
  request: CrossModeWorkRequest,
  publisher: CrossModeWorkPublisher,
): Promise<CrossModeWorkResult> {
  if (!NON_EMPTY_STRING(request.fromWorkId)) {
    throw new Error("fromWorkId is required");
  }
  if (!isWorkMode(request.fromMode)) {
    throw new Error(`unknown work mode: ${String(request.fromMode)}`);
  }
  if (!isWorkMode(request.toMode)) {
    throw new Error(`unknown work mode: ${String(request.toMode)}`);
  }
  if (request.toMode === request.fromMode) {
    throw new Error("cross-mode work requires a new work mode");
  }
  if (!isAllowedCrossModeHandoff(request.fromMode, request.toMode)) {
    throw new Error(`cross-mode handoff ${request.fromMode}->${request.toMode} is not allowed`);
  }
  if (!NON_EMPTY_STRING(request.objective)) {
    throw new Error("objective is required");
  }
  if (!NON_EMPTY_STRING(request.authorityPolicyRef)) {
    throw new Error("authorityPolicyRef is required");
  }
  if (!NON_EMPTY_STRING(request.budgetPolicyRef)) {
    throw new Error("budgetPolicyRef is required");
  }
  if (!NON_EMPTY_STRING(request.causationId)) {
    throw new Error("causationId is required");
  }
  const published = await publisher.publish({
    workMode: request.toMode,
    objective: request.objective,
    authorityPolicyRef: request.authorityPolicyRef,
    budgetPolicyRef: request.budgetPolicyRef,
    parentWorkId: request.fromWorkId,
    causationId: request.causationId,
  });
  if (!NON_EMPTY_STRING(published?.workId)) {
    throw new Error("cross-mode publisher must return a new workId");
  }
  if (published.workId === request.fromWorkId) {
    throw new Error("cross-mode work must produce a new work id");
  }
  return {
    workId: published.workId,
    workMode: request.toMode,
    parentWorkId: request.fromWorkId,
    causationId: request.causationId,
  };
}
