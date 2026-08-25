import { describe, expect, it } from "vitest";
import {
  isTaskSuspensionStructurallyValid,
  isIntentProposalStructurallyValid,
  isTaskDraftStructurallyValid,
  isTaskDraftSubmissionStructurallyValid,
  isQualityGateResultStructurallyValid,
  type TaskSuspension,
} from "@away_from/pth-contracts";

describe("contracts/human-interaction：TaskSuspension 契约", () => {
  it("human：requestId 必填，reason 可选", () => {
    const human: TaskSuspension = {
      kind: "human",
      requestId: "req-1",
      reason: "需要批准",
    };
    expect(isTaskSuspensionStructurallyValid(human)).toBe(true);
    expect(isTaskSuspensionStructurallyValid({ kind: "human", requestId: "req-2" })).toBe(true);
    expect(isTaskSuspensionStructurallyValid({ kind: "human", reason: "缺 requestId" })).toBe(false);
    expect(isTaskSuspensionStructurallyValid({ kind: "human", requestId: "" })).toBe(false);
  });

  it("publisher-question：question 必填，context 可选", () => {
    const question: TaskSuspension = {
      kind: "publisher-question",
      question: "这个需求的目标客户是谁？",
      context: { source: "task-1" },
    };
    expect(isTaskSuspensionStructurallyValid(question)).toBe(true);
    expect(isTaskSuspensionStructurallyValid({ kind: "publisher-question", question: "确认一下" })).toBe(true);
    expect(isTaskSuspensionStructurallyValid({ kind: "publisher-question" })).toBe(false);
    expect(isTaskSuspensionStructurallyValid({ kind: "publisher-question", question: "" })).toBe(false);
    expect(isTaskSuspensionStructurallyValid({ kind: "publisher-question", question: "x", context: [] })).toBe(false);
  });

  it("未知 kind 拒绝", () => {
    expect(isTaskSuspensionStructurallyValid({ kind: "other", requestId: "x" })).toBe(false);
    expect(isTaskSuspensionStructurallyValid(null)).toBe(false);
  });
});

describe("contracts/human-interaction：N25 Intent/TaskDraft/QualityGate 契约", () => {
  it("IntentProposal 校验", () => {
    expect(isIntentProposalStructurallyValid({ mode: "request", confidence: 0.8, title: "T", text: "X" })).toBe(true);
    expect(isIntentProposalStructurallyValid({ mode: "chitchat", confidence: 0.5 })).toBe(true);
    expect(isIntentProposalStructurallyValid({ mode: "unknown", confidence: 0.5 })).toBe(false);
    expect(isIntentProposalStructurallyValid({ mode: "request", confidence: 1.2 })).toBe(false);
  });

  it("TaskDraft 校验", () => {
    const draft = {
      id: "d1", revision: 1, tenantId: "t", principalId: "p",
      title: "T", text: "X", status: "draft" as const,
      createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z", contentHash: "h",
    };
    expect(isTaskDraftStructurallyValid(draft)).toBe(true);
    expect(isTaskDraftStructurallyValid({ ...draft, revision: 0 })).toBe(false);
    expect(isTaskDraftStructurallyValid({ ...draft, title: "" })).toBe(false);
  });

  it("TaskDraftSubmission / QualityGateResult 校验", () => {
    expect(isTaskDraftSubmissionStructurallyValid({ draftId: "d1", revision: 1, submittedAt: "2026-08-24T00:00:00.000Z" })).toBe(true);
    expect(isTaskDraftSubmissionStructurallyValid({ draftId: "", revision: 1, submittedAt: "2026-08-24T00:00:00.000Z" })).toBe(false);
    expect(isQualityGateResultStructurallyValid({ pass: true, checks: ["a"], failures: [] })).toBe(true);
    expect(isQualityGateResultStructurallyValid({ pass: false, checks: [], failures: [1] })).toBe(false);
  });
});
