// hello-world 扩展工厂——兼容性扩展接口示例（四类 contracts 演示）
module.exports = function factory(ctx) {
  return {
    tools: {
      greet: async (args) => ({ ok: true, result: `Hello, ${args.name ?? "world"}!` }),
    },
    capabilities: {
      hello_capability: async () => "hello from extension",
    },
    events: {
      "task.claim": async (e) => { ctx.log?.(`[hello-world] task claimed: ${e.payload.taskId}`); },
      "task.submit": async (e) => { ctx.log?.(`[hello-world] task submitted: ${e.payload.taskId}`); },
    },
    roles: [
      { id: "greeting-agent", labelPatterns: ["greeting", "hello"], prompt: "你是问候专员——负责生成友好问候与祝福。", capabilities: ["memory", "fs"], memoryScope: "own" },
    ],
  };
};
