/**
 * worker-units.ts —— 统一 LLM worker / code worker 契约（Wave 1）。
 *
 * 统一的是身份/版本/输入输出/预算/遥测/治理描述，不强行合并调度通道：
 *  - llm    → 任务队列 / agent loop；
 *  - code   → loop runtime / drainer / scheduler；
 *  - hybrid → 二者组合。
 */

import { isWorkerKind, type WorkerKind } from "@away_from/pth-contracts";

export type { WorkerKind };

export interface WorkerUnitSpec {
  readonly id: string;
  readonly kind: WorkerKind;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  /** role worker 的角色 id；观察策略 / intake processor 可省略。 */
  readonly roleId?: string;
  /** code worker 的处理函数/策略引用。 */
  readonly processorRef?: string;
  readonly inputSchemaRef?: string;
  readonly outputSchemaRef?: string;
  readonly budgetRef?: string;
  readonly telemetryRef?: string;
  readonly governanceRef?: string;
  readonly tags?: readonly string[];
}

export interface WorkerUnitRegistration {
  readonly spec: WorkerUnitSpec;
}

export class WorkerRegistry {
  private readonly workers = new Map<string, WorkerUnitRegistration>();

  register(spec: WorkerUnitSpec): void {
    if (spec.id.trim() === "") throw new Error("worker id is required");
    if (!isWorkerKind(spec.kind)) throw new Error(`unknown worker kind: ${String(spec.kind)}`);
    if (this.workers.has(spec.id)) throw new Error(`worker already registered: ${spec.id}`);
    this.workers.set(spec.id, { spec });
  }

  get(id: string): WorkerUnitRegistration | undefined {
    return this.workers.get(id);
  }

  has(id: string): boolean {
    return this.workers.has(id);
  }

  list(): readonly WorkerUnitRegistration[] {
    return [...this.workers.values()];
  }

  listByKind(kind: WorkerKind): readonly WorkerUnitRegistration[] {
    return this.list().filter((w) => w.spec.kind === kind);
  }
}

/**
 * 模板 handoff 只作建议：真实接手身份由路由与 Worker Registry 决定。
 * 本函数只做“建议是否能被 registry 认可”的校验，不做实际路由。
 */
export function resolveAdvisoryWorkerKind(
  spec: Pick<WorkerUnitSpec, "id" | "kind">,
  advisory: { nextWorkerKind?: WorkerKind; requiresApproval?: boolean } | undefined,
): { accepted: boolean; reason?: string } {
  if (!advisory?.nextWorkerKind) return { accepted: true };
  if (!isWorkerKind(advisory.nextWorkerKind)) {
    return { accepted: false, reason: `invalid advisory nextWorkerKind: ${String(advisory.nextWorkerKind)}` };
  }
  if (advisory.requiresApproval === false && spec.kind !== "hybrid") {
    // 路由允许 hybrid 自行选择；非 hybrid 不能通过模板建议降低审批。
    return { accepted: false, reason: "template handoff cannot loosen approval requirements" };
  }
  return { accepted: true };
}
