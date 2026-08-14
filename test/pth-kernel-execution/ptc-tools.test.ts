import { describe, it, expect } from "vitest";
import { PTC_TOOL_DEFS, buildToolSchemas, renderToolDescription } from "../../src/pth/kernel/ptc/tools";
import { toolSchemaFor, toolsToSchema } from "../../src/pth/kernel/execution/agent-tools";

/** 旧手写顺序（prompt 文本顺序——golden 钉死） */
const GOLDEN_NAMES = [
  "python.run", "python.eval", "bash.run", "bash.eval", "ts.run", "ts.eval", "done",
  "dev.write", "dev.edit", "dev.build", "dev.run", "dev.save", "dev.list",
  "debug.attach", "debug.breakpoint", "debug.continue", "debug.step", "debug.snapshot",
  "debug.evaluate", "debug.detach", "debug.sessions",
  "write.create", "write.edit", "write.read", "write.list", "write.save", "write.section",
  "asp.cd", "asp.create", "asp.destroy", "asp.index", "memory.index",
  "cache.load", "cache.index", "cache.cancel",
];

/** 旧手写描述 spot-check（逐字节） */
const GOLDEN_DESCRIPTIONS: Record<string, string> = {
  "python.run": "【场景锚点：python 程序——python 生态/数据计算的多语句执行】何时用：需要 python 库、多语句/循环、_result 值回传；ts 能做的用 ts（ts 程序内可 await python 能力）。效果：多语句执行，_result 值回传。",
  "ts.run": "【场景锚点：ts 程序（程序模式——优先）——一个程序组合多能力】何时用：多步操作/变量/循环/组合能力函数（memory/llm/web/fs/python/bash）——优先写一个程序而非分步发多个动作；大内容一次取回后在程序内本地处理（切片/过滤/聚合），不重复分片读取。效果：return 值回填 + stdout 可见。",
  "done": "【场景锚点：任务完成——提交最终产出】何时用：有实际产物（实现/文件/计算结果）或明确无法完成（说明原因）时。效果：任务结案；result 为空会被拒绝并回填引导（ASP：仅元空间可用）。",
  "asp.create": "【场景锚点：空间生成（治理）】何时用：父空间声明 allowChildren 且填 childParams 表单（能力面收窄+记忆域分配）；meta 禁建。效果：注册子空间，可 asp.cd 进入。",
  "cache.load": "【场景锚点：跨空间携带数据——离开空间前先存】何时用：后续步骤要反复取用的数据先载入（任何空间可引用）；来源 id/ids/tag 或 key+content。效果：条目入随身缓存（硬容量限制，超容拒绝需先 cancel）。",
  "memory.index": "【场景锚点：记忆库地图——查询/统计第一步必用】何时用：避免逐条 SQL 盲查；统计任务一次就够，不要每步重复索引。效果：顶层视图（kind 分布+热门 tag）/ tag 清单 / id 摘要+出边。",
};

describe("工具契约注册表（A1 Phase 3 条目 10——ptc/tools 生成器）", () => {
  it("35 条工具定义——顺序与旧手写一致", () => {
    expect(PTC_TOOL_DEFS.map((d) => d.name)).toEqual(GOLDEN_NAMES);
  });

  it("每条三要素齐全 + description 组装格式统一", () => {
    for (const d of PTC_TOOL_DEFS) {
      expect(d.anchor.trim().length, d.name + " 缺锚点").toBeGreaterThan(0);
      expect(d.whenToUse.trim().length, d.name + " 缺何时用").toBeGreaterThan(0);
      expect(d.effect.trim().length, d.name + " 缺效果").toBeGreaterThan(0);
      expect(renderToolDescription(d)).toBe(`【场景锚点：${d.anchor}】何时用：${d.whenToUse}。效果：${d.effect}。`);
      expect(d.required.every((k) => Object.prototype.hasOwnProperty.call(d.properties, k)), d.name + " required 不在 properties").toBe(true);
    }
  });

  it("buildToolSchemas 派生——35 键 + description 与旧手写逐字节一致", () => {
    const schemas = buildToolSchemas();
    expect(Object.keys(schemas)).toEqual(GOLDEN_NAMES);
    for (const [name, desc] of Object.entries(GOLDEN_DESCRIPTIONS)) {
      expect(schemas[name]?.description, name).toBe(desc);
    }
  });

  it("agent-tools 接线：TOOL_SCHEMAS 已由生成器派生（toolSchemaFor 读同一真相源）", () => {
    expect(toolSchemaFor("python.run")?.description).toBe(GOLDEN_DESCRIPTIONS["python.run"]);
    expect(toolSchemaFor("asp_create")?.name).toBe("asp_create");   // 下划线形归一
    const tools = toolsToSchema();
    expect(tools).toHaveLength(35);
    expect(tools.some((t) => t.name === "cache_load")).toBe(true);
    expect(tools.some((t) => t.name === "ts_run")).toBe(true);
    // OpenAI tool name 合法性（无点）
    expect(tools.every((t) => /^[A-Za-z0-9_-]+$/.test(t.name))).toBe(true);
  });
});
