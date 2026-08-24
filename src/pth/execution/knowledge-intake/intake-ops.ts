/**
 * execution/knowledge-intake/intake-ops.ts —— N26 持续运营骨架：指标计数。
 */

export interface IntakeOpsSnapshot {
  fetched: number;
  promoted: number;
  failed: number;
  deadLetters: number;
}

export class IntakeOpsRegistry {
  private counts: IntakeOpsSnapshot = { fetched: 0, promoted: 0, failed: 0, deadLetters: 0 };

  record(event: keyof IntakeOpsSnapshot): void {
    this.counts[event] += 1;
  }

  snapshot(): IntakeOpsSnapshot {
    return { ...this.counts };
  }
}
