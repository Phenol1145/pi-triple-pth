import { describe, expect, it } from "vitest";
import { resolveNotebookTarget } from "../../packages/pth-kernel-execution/src/execution/notebook-target-router.js";
import type { ExecutionTargetRegistry } from "../../packages/pth-contracts/src/execution-target.js";

const registry: ExecutionTargetRegistry = {
  get: (id) => (id === "sandbox"
    ? {
        id: "sandbox",
        kind: "kernel-pool",
        profile: "sandbox-untrusted",
        languages: ["python", "bash"],
        modes: { sync: true, stream: false, interactive: false, persistent: true },
        session: { type: "persistent-repl", scope: "notebook" },
        capabilities: { richMedia: true, streaming: false, cancel: true, pathMapping: false },
        routing: { defaultFor: ["python", "bash"], userSelectable: false, requiresApproval: false },
        binding: { type: "execution-session", backendId: "sandbox" },
      }
    : undefined),
  list: () => new Map(),
  resolve: (language, target) => {
    if (target === "sandbox" || target === null) return {
      id: "sandbox",
      kind: "kernel-pool",
      profile: "sandbox-untrusted",
      languages: ["python", "bash"],
      modes: { sync: true, stream: false, interactive: false, persistent: true },
      session: { type: "persistent-repl", scope: "notebook" },
      capabilities: { richMedia: true, streaming: false, cancel: true, pathMapping: false },
      routing: { defaultFor: ["python", "bash"], userSelectable: false, requiresApproval: false },
      binding: { type: "execution-session", backendId: "sandbox" },
    };
    throw new Error(`unexpected resolve ${language}/${String(target)}`);
  },
};

describe("NotebookTargetRouter", () => {
  it("按 registry.resolve 解析并返回 target", () => {
    const { target } = resolveNotebookTarget(registry, "python");
    expect(target.id).toBe("sandbox");
  });

  it("null target 走默认路由", () => {
    const { target } = resolveNotebookTarget(registry, "bash", null);
    expect(target.id).toBe("sandbox");
  });
});
