/**
 * execution/task-cognitive-ledger-outbox.ts —— N28 M3：任务认知账本 outbox 骨架（内存）。
 *
 * 生产化计划：账本写操作与任务状态同事务，经 outbox 投影到观测面。
 */

export interface CognitiveLedgerEvent {
  id: string;
  type: "budget-reset" | "factor-recorded";
  taskId: string;
  workerId: string;
  payload: Record<string, unknown>;
  at: number;
}

export class CognitiveLedgerOutbox {
  private readonly events: CognitiveLedgerEvent[] = [];

  append(event: CognitiveLedgerEvent): void {
    this.events.push(event);
  }

  drain(): CognitiveLedgerEvent[] {
    return this.events.splice(0, this.events.length);
  }

  pending(): CognitiveLedgerEvent[] {
    return [...this.events];
  }
}
