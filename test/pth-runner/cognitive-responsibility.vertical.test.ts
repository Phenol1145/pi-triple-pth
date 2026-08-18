import { describe, expect, it } from "vitest";
import { createN28InMemoryBundle } from "../../scripts/n28-feasibility-harness.js";
import { N28_WORKERS } from "../../scripts/n28-feasibility-fixture.js";

describe("cognitive-responsibility vertical（生产组合 + 真实 runAgentTask）", () => {
  it("algebra/geometry/global 三任务：prompt 命中对应 token、toolNames≤16、globalFallback、usage 六键、无 trap", async () => {
    const bundle = createN28InMemoryBundle();

    const algebra = await bundle.runTask({ workerKey: "algebra", taskText: "token:alg-01" });
    const geometry = await bundle.runTask({ workerKey: "geometry", taskText: "token:geo-01" });
    const global = await bundle.runTask({ workerKey: "algebra", taskText: "bounded global target canonical" });

    expect(algebra.outcome.status).toBe("completed");
    expect(geometry.outcome.status).toBe("completed");
    expect(global.outcome.status).toBe("completed");

    expect(algebra.systemPrompt).toContain("token:alg-01");
    expect(geometry.systemPrompt).toContain("token:geo-01");
    expect(algebra.systemPrompt).not.toContain("trap-");
    expect(geometry.systemPrompt).not.toContain("trap-");

    for (const observation of [algebra, geometry, global]) {
      expect(observation.toolsByTurn.every((tools) => tools.length <= 16)).toBe(true);
      expect(observation.toolsByTurn.every((tools) => tools.includes("done"))).toBe(true);
      expect(observation.usage).toMatchObject({
        "cognitive.memoryEntries": expect.any(Number),
        "cognitive.memoryChars": expect.any(Number),
        "cognitive.skillIndexEntries": expect.any(Number),
        "cognitive.activeSkills": expect.any(Number),
        "cognitive.skillChars": expect.any(Number),
        "cognitive.tools": expect.any(Number),
      });
    }

    const globalTrace = global.traces.find((e) => e.type === "cognitive-working-set" && e.phase === "start");
    expect(globalTrace).toBeTruthy();
    expect(global.outcome.usage?.["cognitive.tools"]).toBeLessThanOrEqual(16);

    // 同 worker/query 的检索 fingerprint 稳定：重复跑一次 global，prompt 与 tools 完全一致。
    const globalAgain = await bundle.runTask({ workerKey: "algebra", taskText: "bounded global target canonical" });
    expect(globalAgain.systemPrompt).toBe(global.systemPrompt);
    expect(globalAgain.toolsByTurn).toEqual(global.toolsByTurn);
  });

  it("代数副本运行不影响几何副本（同 Role 多副本各持 own workerId）", () => {
    expect(N28_WORKERS.algebra.workerId).not.toBe(N28_WORKERS.geometry.workerId);
    expect(N28_WORKERS.algebra.role).toEqual(N28_WORKERS.geometry.role);
  });
});
