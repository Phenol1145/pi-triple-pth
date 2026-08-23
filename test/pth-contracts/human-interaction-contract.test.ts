import { describe, expect, it } from "vitest";
import {
  isTaskSuspensionStructurallyValid,
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
