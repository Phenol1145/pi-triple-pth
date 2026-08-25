import { describe, it, expect } from "vitest";
import {
  canonicalDelegateSpecDigest,
  canonicalEntrySpecDigest,
  isChildOutcomeEnvelopeStructurallyValid,
  isChildTaskRefStructurallyValid,
  isPublisherQuestionEnvelopeStructurallyValid,
  isRequiredDependency,
  isSubmissionKeyValid,
  stableSerialize,
} from "@away_from/pth-contracts";

describe("持久化子任务委派 V1 契约校验", () => {
  it("submissionKey 只接受 1..128 且 [A-Za-z0-9:_@.-]", () => {
    expect(isSubmissionKeyValid("search:official-docs:q1")).toBe(true);
    expect(isSubmissionKeyValid("a")).toBe(true);
    expect(isSubmissionKeyValid("a".repeat(128))).toBe(true);
    expect(isSubmissionKeyValid("")).toBe(false);
    expect(isSubmissionKeyValid("a".repeat(129))).toBe(false);
    expect(isSubmissionKeyValid("has space")).toBe(false);
    expect(isSubmissionKeyValid("中文")).toBe(false);
    expect(isSubmissionKeyValid(42)).toBe(false);
  });

  it("dependency V1 仅允许 required（undefined 视为合法）", () => {
    expect(isRequiredDependency(undefined)).toBe(true);
    expect(isRequiredDependency("required")).toBe(true);
    expect(isRequiredDependency("detached")).toBe(false);
    expect(isRequiredDependency("any")).toBe(false);
  });

  it("ChildOutcomeEnvelopeV1 结构校验", () => {
    expect(isChildOutcomeEnvelopeStructurallyValid({
      status: "completed",
      summary: "ok",
      provenance: [],
      artifactRefs: [],
    })).toBe(true);
    expect(isChildOutcomeEnvelopeStructurallyValid({
      status: "rejected",
      summary: "bad",
      provenance: ["trace-1"],
      artifactRefs: ["archive://x"],
      error: { family: "exec", message: "boom", retryable: false },
    })).toBe(true);
    expect(isChildOutcomeEnvelopeStructurallyValid({ status: "running", summary: "", provenance: [], artifactRefs: [] })).toBe(false);
    expect(isChildOutcomeEnvelopeStructurallyValid({ status: "completed", summary: "", provenance: [], artifactRefs: [], error: { family: "x", message: "y", retryable: true } })).toBe(false);
  });

  it("PublisherQuestionEnvelopeV1 结构校验", () => {
    expect(isPublisherQuestionEnvelopeStructurallyValid({
      questionId: "child-1",
      prompt: "需要澄清",
      childTaskId: "child-1",
    })).toBe(true);
    expect(isPublisherQuestionEnvelopeStructurallyValid({ questionId: "", prompt: "x", childTaskId: "c" })).toBe(false);
  });

  it("stableSerialize 对对象键排序、数组保序、字符串 NFKC 归一化", () => {
    expect(stableSerialize({ b: 1, a: 2 })).toBe(stableSerialize({ a: 2, b: 1 }));
    expect(stableSerialize([1, 2])).not.toBe(stableSerialize([2, 1]));
    expect(stableSerialize({ s: "\u00E9" })).toBe(stableSerialize({ s: "e\u0301" }));
    expect(stableSerialize({ x: undefined })).toBe(stableSerialize({}));
  });

  it("canonicalDelegateSpecDigest 与对象键顺序无关，与内容相关", () => {
    const base = {
      to: "coder",
      title: "t",
      text: "x",
      context: { b: 1, a: { y: 2, x: 1 } },
      domains: ["math"],
      expect: "result",
      dependency: "required",
    };
    const reordered = {
      dependency: "required",
      expect: "result",
      domains: ["math"],
      context: { a: { x: 1, y: 2 }, b: 1 },
      text: "x",
      title: "t",
      to: "coder",
    };
    expect(canonicalDelegateSpecDigest(base)).toBe(canonicalDelegateSpecDigest(reordered));
    expect(canonicalDelegateSpecDigest({ ...base, text: "y" })).not.toBe(canonicalDelegateSpecDigest(base));
  });

  it("canonicalEntrySpecDigest 与对象键顺序无关，与入口正文相关", () => {
    const base = { title: "t", text: "x", tags: ["code"], goal: "g", domains: ["math"] };
    expect(canonicalEntrySpecDigest(base)).toBe(canonicalEntrySpecDigest({
      domains: ["math"],
      goal: "g",
      tags: ["code"],
      text: "x",
      title: "t",
    }));
    expect(canonicalEntrySpecDigest({ ...base, text: "y" })).not.toBe(canonicalEntrySpecDigest(base));
    expect(canonicalEntrySpecDigest({ ...base, domains: ["physics"] })).not.toBe(canonicalEntrySpecDigest(base));
  });

  it("ChildTaskRefV1 结构校验", () => {
    expect(isChildTaskRefStructurallyValid({
      taskId: "child-1",
      submissionKey: "search:q1",
      roleId: "scout",
      path: ["actuator", "scout"],
      state: "running",
    })).toBe(true);
    expect(isChildTaskRefStructurallyValid({
      taskId: "child-1",
      submissionKey: "search:q1",
      roleId: "scout",
      path: ["actuator", "scout"],
      state: "terminal",
      observation: { status: "completed", summary: "s", provenance: [], artifactRefs: [] },
    })).toBe(true);
    expect(isChildTaskRefStructurallyValid({
      taskId: "child-1",
      submissionKey: "search:q1",
      roleId: "scout",
      path: ["actuator", "scout"],
      state: "bogus",
    })).toBe(false);
  });
});
