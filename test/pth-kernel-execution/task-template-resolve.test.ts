import { describe, it, expect } from "vitest";
import { resolveTemplateTask, interpolateEventVars, listPublicTemplates } from "@away_from/pth-kernel-interpreter";

describe("resolveTemplateTask（任务模板统一收口 A+：发布/trigger/perf 共用解析器）", () => {
  it("基本解析：recon-doc → title=[id] name、tags=[roleTag]、payload 含 template/params", () => {
    const r = resolveTemplateTask({ template: "recon-doc", params: { url: "https://example.com/doc" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.title).toBe("[recon-doc] 信息搜集（文档转写）");
    expect(r.tags).toEqual(["recon"]);
    expect(r.text).toContain('"https://example.com/doc"');
    expect(r.payload).toMatchObject({ template: "recon-doc", params: { url: "https://example.com/doc" } });
    expect(r.goal).toBe("忠实转写指定 URL 文档为结构化记忆条目：不偏离原文、不补充源外信息、不臆造内容。");
  });

  it("生命周期 P0：显式 goal 覆盖模板 goal；空白显式 goal 回退模板 goal", () => {
    const r1 = resolveTemplateTask({ template: "recon-doc", params: { url: "u" }, goal: "本次只转写前两章" });
    expect(r1.ok && r1.goal).toBe("本次只转写前两章");
    const r2 = resolveTemplateTask({ template: "recon-doc", params: { url: "u" }, goal: "   " });
    expect(r2.ok && r2.goal).toBe("忠实转写指定 URL 文档为结构化记忆条目：不偏离原文、不补充源外信息、不臆造内容。");
  });

  it("事件变量注入：params 值经 {{key}} 替换后渲染", () => {
    const r = resolveTemplateTask(
      { template: "recon-doc", params: { url: "{{detail}}", section: "{{role}}" } },
      { eventVars: { taskId: "t1", role: "developer", detail: "https://x.dev/a" } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('"https://x.dev/a"');
    expect(r.text).toContain('"developer"');
    expect(r.payload.params).toEqual({ url: "https://x.dev/a", section: "developer" });
  });

  it("必填校验在注入之后：{{detail}} 为空 → missing", () => {
    const r = resolveTemplateTask(
      { template: "recon-doc", params: { url: "{{detail}}" } },
      { eventVars: { detail: "" } },
    );
    expect(r).toEqual({ ok: false, code: "missing-params", error: "missing required params: url", missing: ["url"] });
  });

  it("unknown-template → 结构化错误", () => {
    expect(resolveTemplateTask({ template: "nope" })).toEqual({ ok: false, code: "unknown-template", error: "unknown template: nope" });
  });

  it("路由优先级：显式 role > 显式 tags > roleTag；三者都返回", () => {
    const r1 = resolveTemplateTask({ template: "recon-doc", params: { url: "u" }, tags: ["custom"] });
    expect(r1.ok && r1.tags).toEqual(["custom"]);
    expect(r1.ok && r1.role).toBeUndefined();
    const r2 = resolveTemplateTask({ template: "recon-doc", params: { url: "u" }, tags: ["custom"], role: "scout" });
    expect(r2.ok && r2.role).toBe("scout");
    expect(r2.ok && r2.tags).toEqual(["custom"]);
  });

  it("标题覆盖支持事件变量 + 额外 payload 合并", () => {
    const r = resolveTemplateTask(
      { template: "recon-doc", params: { url: "u" }, title: "转写 {{role}}", payload: { source: "trigger" } },
      { eventVars: { role: "scout" } },
    );
    expect(r.ok && r.title).toBe("转写 scout");
    expect(r.ok && r.payload).toMatchObject({ template: "recon-doc", source: "trigger" });
  });
});

describe("interpolateEventVars（递归注入）", () => {
  it("字符串/数组/对象三形态", () => {
    expect(interpolateEventVars("{{a}}-{{b}}", { a: "1", b: "2" })).toBe("1-2");
    expect(interpolateEventVars(["{{a}}", "x"], { a: "v" })).toEqual(["v", "x"]);
    expect(interpolateEventVars({ u: "{{detail}}", n: 1, nested: { k: "{{role}}" } }, { detail: "d", role: "r" }))
      .toEqual({ u: "d", n: 1, nested: { k: "r" } });
  });
});

describe("listPublicTemplates", () => {
  it("公开列表含四个业务模板；hidden 系统内部模板（memory-sweep）不外显但可解析", () => {
    const ids = listPublicTemplates().map((t) => t.id);
    expect(ids).toContain("recon-doc");
    expect(ids).toContain("memory-maintain");
    expect(ids).toContain("dev-task");
    expect(ids).toContain("dev-task-ts");
    expect(ids).not.toContain("memory-sweep");
    const r = resolveTemplateTask({ template: "memory-sweep" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.title).toBe("记忆维护巡检（归档候选提案）");
  });
});
