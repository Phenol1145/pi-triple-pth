import { describe, it, expect } from "vitest";
import { ScriptedLlmFn } from "../../src/pth/bench/scripted-llm.js";

describe("PTH Bench W3 ScriptedLlmFn", () => {
  it("按剧本顺序返回 toolCalls，越界后自动 done", async () => {
    const llm = new ScriptedLlmFn([
      { toolCalls: [{ name: "ts.run", arguments: { code: "return 1" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: true } } }] },
    ]);
    const r1 = await llm.complete([], {});
    expect(r1.toolCalls?.[0]?.name).toBe("ts.run");
    const r2 = await llm.complete([], {});
    expect(r2.toolCalls?.[0]?.name).toBe("done");
    const r3 = await llm.complete([], {});
    expect(r3.toolCalls?.[0]?.name).toBe("done");
  });
});
