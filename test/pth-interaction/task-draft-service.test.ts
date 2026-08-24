import { describe, it, expect } from "vitest";
import { TaskDraftService } from "../../src/pth/interaction/task-draft-service.js";

describe("N25 TaskDraft Service", () => {
  it("create/update 版本化", () => {
    const svc = new TaskDraftService();
    const d = svc.create({ tenantId: "t", principalId: "p", title: "T", text: "X" });
    expect(d.revision).toBe(1);
    const d2 = svc.update(d.id, { text: "Y" })!;
    expect(d2.revision).toBe(2);
    expect(d2.contentHash).not.toBe(d.contentHash);
  });

  it("quality gate 通过后可 submit", () => {
    const svc = new TaskDraftService();
    const d = svc.create({ tenantId: "t", principalId: "p", title: "T", text: "X" });
    const gate = svc.runQualityGate(d.id)!;
    expect(gate.pass).toBe(true);
    const sub = svc.submit(d.id)!;
    expect(sub.draftId).toBe(d.id);
    expect(svc.get(d.id)!.status).toBe("submitted");
  });

  it("空 draft 不通过 quality gate", () => {
    const svc = new TaskDraftService();
    const d = svc.create({ tenantId: "t", principalId: "p", title: "", text: "" });
    const gate = svc.runQualityGate(d.id)!;
    expect(gate.pass).toBe(false);
    expect(svc.submit(d.id)).toBeUndefined();
  });
});
