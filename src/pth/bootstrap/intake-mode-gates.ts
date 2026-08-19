/**
 * bootstrap/intake-mode-gates.ts —— N29 refix P0-9：draft/full 模式的纯判定门。
 *
 * - draft：stage handler 集合剔除 promote（只到 private draft + open plan）。
 * - full：启动必须出示绑定当前构建 commit 的 MIN_INNER_LOOP_GO 验收 envelope；
 *   缺失/非 GO/不绑定一律抛错（启动期 fail closed）。
 *
 * 纯函数无副作用，可单测；batch-process.ts 只做薄装配。
 */

export type IntakeMode = "off" | "draft" | "full";

/** draft 模式剔除 promote handler；full 原样返回；off 返回空集合。 */
export function selectIntakeStageHandlers<T>(
  mode: IntakeMode,
  handlers: Record<string, T>,
  promoteKind: string,
): Record<string, T> {
  if (mode === "off") return {};
  if (mode === "draft") {
    const out = { ...handlers };
    delete out[promoteKind];
    return out;
  }
  return { ...handlers };
}

export interface IntakeAcceptanceEnvelopeLike {
  readonly decision?: string;
  readonly evaluatedCommit?: string;
  readonly implementationTreeClean?: boolean;
}

/**
 * full 模式启动门：验收 envelope 必须 decision=MIN_INNER_LOOP_GO、绑定非空
 * evaluatedCommit、implementationTreeClean=true；若提供 buildCommit 则必须一致。
 * 任一不符抛错（启动失败）。
 */
export function assertIntakeFullAcceptance(
  envelope: IntakeAcceptanceEnvelopeLike,
  buildCommit?: string,
): void {
  if (envelope.decision !== "MIN_INNER_LOOP_GO") {
    throw new Error(
      `PTH_KNOWLEDGE_INTAKE_MODE=full 被拒绝：验收 envelope decision=${envelope.decision ?? "<missing>"}（需要 MIN_INNER_LOOP_GO）`,
    );
  }
  if (!envelope.evaluatedCommit || envelope.implementationTreeClean !== true) {
    throw new Error("PTH_KNOWLEDGE_INTAKE_MODE=full 被拒绝：envelope 缺少 evaluatedCommit 或 implementationTreeClean");
  }
  const commit = (buildCommit ?? "").trim();
  if (commit && envelope.evaluatedCommit !== commit) {
    throw new Error(
      `PTH_KNOWLEDGE_INTAKE_MODE=full 被拒绝：envelope evaluatedCommit=${envelope.evaluatedCommit} 与当前构建 ${commit} 不一致`,
    );
  }
}
