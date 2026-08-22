import { describe, expect, it } from "vitest";
import {
  attachEntryDelivery,
  buildCompletedResultWriteback,
  buildEntryDelivery,
  buildErrorResultWriteback,
  encodeResultForPayload,
  isTaskDeliveryStructurallyValid,
  toDeliveryArtifactRef,
  TASK_RESULT_MAX_BYTES,
  type ArtifactRef,
  type TaskDelivery,
} from "@away_from/pth-contracts";

describe("contracts/tasking W8 P0：TaskDelivery 契约", () => {
  it("buildEntryDelivery：入口任务 path=[role]，lineageId=自身 id，不设 parent", () => {
    expect(buildEntryDelivery("task-1", "developer")).toEqual({
      path: ["developer"],
      lineageId: "task-1",
    });
    expect(buildEntryDelivery("", "developer")).toBeNull();
    expect(buildEntryDelivery("task-1", "")).toBeNull();
  });

  it("attachEntryDelivery：payload.delivery 单键包裹，既有 payload 字段保留、伪造 delivery 被覆盖", () => {
    const stamped = attachEntryDelivery(
      { flow: { stages: [] }, delivery: { path: ["forged"], lineageId: "forged" } },
      "task-2",
      "coder",
    );
    expect(stamped).toEqual({
      flow: { stages: [] },
      delivery: { path: ["coder"], lineageId: "task-2" },
    });
    // 非对象 payload 归一化为对象
    expect(attachEntryDelivery(42, "task-3", "coder")).toEqual({
      delivery: { path: ["coder"], lineageId: "task-3" },
    });
  });

  it("isTaskDeliveryStructurallyValid：完整/缺省形状都接受，坏形状拒绝", () => {
    const full: TaskDelivery = {
      parent: { taskId: "p-1", roleId: "developer", typePath: ["origin", "developer"] },
      path: ["origin", "developer", "coder"],
      lineageId: "root-1",
      replyTo: "parent",
      artifactRef: { kind: "file", id: "archive://task-p-1/out.ts" },
    };
    expect(isTaskDeliveryStructurallyValid(full)).toBe(true);
    expect(isTaskDeliveryStructurallyValid({ path: ["origin"], lineageId: "self" })).toBe(true);

    expect(isTaskDeliveryStructurallyValid(null)).toBe(false);
    expect(isTaskDeliveryStructurallyValid({ lineageId: "x" })).toBe(false); // 缺 path
    expect(isTaskDeliveryStructurallyValid({ path: [], lineageId: "x" })).toBe(false); // path 空
    expect(isTaskDeliveryStructurallyValid({ path: ["x"], lineageId: "" })).toBe(false);
    expect(isTaskDeliveryStructurallyValid({ path: ["x"], lineageId: "x", replyTo: "nowhere" })).toBe(false);
    expect(isTaskDeliveryStructurallyValid({ path: ["x"], lineageId: "x", artifactRef: { kind: "cache", id: "x" } })).toBe(false);
    expect(isTaskDeliveryStructurallyValid({
      path: ["x"], lineageId: "x", parent: { taskId: "p", roleId: "dev", typePath: [] },
    })).toBe(false);
  });

  it("encodeResultForPayload：JSON-safe 结果 round-trip 结构保留", () => {
    const encoded = encodeResultForPayload({ value: { answer: 42 }, summary: "ok" });
    expect(encoded.truncated).toBe(false);
    expect(encoded.unserializable).toBe(false);
    expect(encoded.value).toEqual({ value: { answer: 42 }, summary: "ok" });
  });

  it("encodeResultForPayload：超上限递归截断且最终 JSON 字节数 ≤ 上限", () => {
    const big = { first: { kept: "yes" }, second: "x".repeat(10_000) };
    const maxBytes = 160;
    const encoded = encodeResultForPayload(big, maxBytes);
    expect(encoded.truncated).toBe(true);
    const out = encoded.value as Record<string, unknown>;
    expect(out.__pthTruncated).toBe(true);
    expect(out.first).toEqual({ kept: "yes" });
    expect(Buffer.byteLength(JSON.stringify(encoded.value), "utf8")).toBeLessThanOrEqual(maxBytes);

    const bigArray = Array.from({ length: 100 }, (_, i) => ({ i, body: "x".repeat(1000) }));
    const arrEncoded = encodeResultForPayload(bigArray, 512);
    expect(arrEncoded.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(arrEncoded.value), "utf8")).toBeLessThanOrEqual(512);
  });

  it("encodeResultForPayload：循环引用/不可序列化根值降级为错误摘要，不抛错", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const encoded = encodeResultForPayload(circular);
    expect(encoded.unserializable).toBe(true);
    expect((encoded.value as Record<string, unknown>).__pthUnserializable).toBe(true);

    const undef = encodeResultForPayload(undefined);
    expect(undef.unserializable).toBe(true);
    expect((undef.value as Record<string, unknown>).__pthUnserializable).toBe(true);
  });

  it("toDeliveryArtifactRef：仅 memory/file/component 映射，其余 kind 返回 null", () => {
    const file: ArtifactRef = { kind: "file", uri: "archive://task-9/out.ts" };
    expect(toDeliveryArtifactRef(file)).toEqual({ kind: "file", id: "archive://task-9/out.ts" });
    expect(toDeliveryArtifactRef({ kind: "cache", uri: "x" })).toBeNull();
    expect(toDeliveryArtifactRef(undefined)).toBeNull();
  });

  it("buildCompletedResultWriteback：result + 首产物 artifactRef 一起回写", () => {
    const wb = buildCompletedResultWriteback(
      { value: 7 },
      [{ kind: "file", uri: "archive://t/out" }, { kind: "file", uri: "archive://t/out2" }],
    );
    expect(wb.result).toEqual({ value: 7 });
    expect(wb.artifactRef).toEqual({ kind: "file", id: "archive://t/out" });

    const noArtifact = buildCompletedResultWriteback({ value: 7 }, []);
    expect(noArtifact.artifactRef).toBeNull();
    expect(TASK_RESULT_MAX_BYTES).toBe(64 * 1024);
  });

  it("buildErrorResultWriteback：终态失败写入 {error:{code,message}} 摘要", () => {
    expect(buildErrorResultWriteback({ code: "exec-failed", message: "boom" })).toEqual({
      result: { error: { code: "exec-failed", message: "boom" } },
      artifactRef: null,
    });
    expect(buildErrorResultWriteback(undefined, "任务已取消")).toEqual({
      result: { error: { code: "rejected", message: "任务已取消" } },
      artifactRef: null,
    });
  });
});
