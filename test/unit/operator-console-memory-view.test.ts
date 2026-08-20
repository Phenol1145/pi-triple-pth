/**
 * test/unit/operator-console-memory-view.test.ts — N33 Task 7 视图模型测试。
 */
import { describe, expect, it } from "vitest";
import {
  buildMemoryCharts,
  createMemoryViewModel,
  MEMORY_MAX_LIMIT,
  MEMORY_REVISION_LIMIT,
} from "../../packages/framework/web/operator-console/memory.js";

describe("operator console memory view", () => {
  it("双饼图分母与切片比率精确", () => {
    const charts = buildMemoryCharts({
      setting: { count: 1, bytes: 10 },
      wiki: { count: 3, bytes: 90 },
      skill: { count: 0, bytes: 0 },
      log: { count: 0, bytes: 0 },
      index: { count: 6, bytes: 20 },
    });
    expect(charts.count.total).toBe(10);
    expect(charts.bytes.total).toBe(120);
    expect(charts.count.slices.find((x) => x.type === "index")?.ratio).toBe(0.6);
    expect(charts.bytes.slices.find((x) => x.type === "wiki")?.ratio).toBe(0.75);
  });

  it("全零输入 empty=true 且无人工 100% 切片", () => {
    const charts = buildMemoryCharts({});
    expect(charts.empty).toBe(true);
    expect(charts.count.total).toBe(0);
    expect(charts.bytes.total).toBe(0);
    expect(charts.count.slices.every((s) => s.ratio === 0)).toBe(true);
    expect(charts.bytes.slices.every((s) => s.ratio === 0)).toBe(true);
  });

  it("过滤变更重置 cursor；分页 ingestion 不重不漏", () => {
    const vm = createMemoryViewModel();
    vm.ingestPage({ items: [{ id: "a" }], cursor: "c1", total: 3 });
    expect(vm.view().cursor).toBe("c1");
    vm.setFilter("type", "wiki");
    expect(vm.view().cursor).toBeNull();
    vm.ingestPage({ items: [{ id: "b" }, { id: "c" }], cursor: "c2", total: 3 });
    expect(vm.view().entries.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("revisions 恰好十条且与条目列表独立", () => {
    const vm = createMemoryViewModel();
    vm.ingestPage({ items: [{ id: "only-entry" }], cursor: null, total: 1 });
    vm.ingestRevisions(Array.from({ length: 25 }, (_, i) => ({ action: `a${i}`, revision: i })));
    expect(vm.view().revisions).toHaveLength(MEMORY_REVISION_LIMIT);
    expect(vm.view().revisionsLimit).toBe(MEMORY_REVISION_LIMIT);
    expect(vm.view().entries).toHaveLength(1);
  });

  it("limit 上限常量 fail-closed（101 拒绝由服务端执行，视图模型冻结上限）", () => {
    expect(MEMORY_MAX_LIMIT).toBe(100);
  });

  it("detail 是惰性独立装载：列表行不携带正文", () => {
    const vm = createMemoryViewModel();
    vm.ingestPage({ items: [{ id: "idx:a", content: "SHOULD-NOT-RENDER" }], cursor: null, total: 1 });
    vm.ingestDetail({ id: "idx:a", content: "body-loaded-lazily", evidence: [] });
    const view = vm.view();
    expect(view.detail.content).toBe("body-loaded-lazily");
    expect(view.entries[0].content).toBeUndefined();
  });

  it("degraded 状态显式标记", () => {
    const vm = createMemoryViewModel();
    expect(vm.view().degraded).toBe(false);
    vm.markDegraded(true);
    expect(vm.view().degraded).toBe(true);
  });
});
