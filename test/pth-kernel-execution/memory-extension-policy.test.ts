import { describe, it, expect } from "vitest";
import { memoryExtension } from "../../src/pth/kernel/extensions/memory.js";

/**
 * core 扩展适配层（extensions/memory.ts → pth-memory 包）的 worker 面端到端规则。
 * 原 test/pth-kernel-execution/memory-policy.test.ts 中依赖 core 的部分迁此；
 * 包级 memory-policy 测试在 packages/pth-memory/test/memory-policy.test.ts。
 */
describe("memory 能力包装（worker 面端到端）", () => {
  function makeMemory() {
    const written: Array<Record<string, unknown>> = [];
    const store = {
      write: async (e: Record<string, unknown>) => { written.push(e); },
      get: async (id: string) => {
        if (id === "role-doc:developer") return { id, kind: "role-doc", anchors: [], content: "c", status: "official", meta: {} };
        // N29 P0-4 探针：一条已存在的知识层 draft 条目（worker 不得把它流转为 official）
        if (id === "kn-draft-1") return { id, kind: "task-insight", anchors: [], content: "c", status: "draft", meta: {} };
        return undefined;
      },
      update: async () => {},
      retrieve: async () => [],
      listIds: async () => [],
      bumpHitCount: async () => {},
    };
    const ctx = {
      dataWorld: {
        memory: store,
        queryReadOnly: async () => [],
      },
    } as never;
    const caps = memoryExtension.provide(ctx as never) as { memory: Record<string, Function> };
    return { memory: caps.memory, written };
  }

  it("worker 写 trigger（config 层）→ 拒绝", async () => {
    const { memory, written } = makeMemory();
    await expect(memory["write"]({ kind: "trigger", content: "{}" })).rejects.toThrow(/config/);
    expect(written).toHaveLength(0);
  });

  it("worker 写分化提案 official → 强制 draft 落库", async () => {
    const { memory, written } = makeMemory();
    await memory["write"]({ kind: "differentiation-proposal", content: "{}", status: "official", meta: { visibility: "public" } });
    expect(written[0]).toMatchObject({ kind: "differentiation-proposal", status: "draft", meta: { spaceScope: { space: "meta", visibility: "public" } } });
  });

  it("N29 P0-4：worker 写知识层 official → 强制 draft 落库（§1.6 外部内容不得 direct official）", async () => {
    const { memory, written } = makeMemory();
    await memory["write"]({ kind: "task-insight", content: "洞察", status: "official", meta: { visibility: "private" } });
    expect(written[0]).toMatchObject({ status: "draft", meta: { spaceScope: { space: "meta", visibility: "private" } } });
  });

  it("N29 P0-4：worker 无法经 memory.update 把知识层 draft 流转为 official", async () => {
    const { memory } = makeMemory();
    await expect(memory["update"]("kn-draft-1", { status: "official" })).rejects.toThrow(/knowledge/);
    // 非 official 的状态流转与内容修正不受影响
    await expect(memory["update"]("kn-draft-1", { content: "修正" })).resolves.toBeUndefined();
  });

  it("worker update 系统文档 → 拒绝（补洞）", async () => {
    const { memory } = makeMemory();
    await expect(memory["update"]("role-doc:developer", { content: "篡改" })).rejects.toThrow(/prompt/);
  });
  it("force 参数不透传（位置形第三参 force 也剥离）", async () => {
    const { memory, written } = makeMemory();
    // 位置形 + force 企图：normalize 后 force 进入 entry 字段但 store 调用不带 opts——store 层 isSystemDocId 仍生效
    await memory["write"]("task-insight", "x", { force: true, anchors: [], visibility: "public" });
    expect(written[0]).toMatchObject({ kind: "task-insight" });
    // store.write 只收到单参 entry（无 opts.force 旁路）
  });
});
