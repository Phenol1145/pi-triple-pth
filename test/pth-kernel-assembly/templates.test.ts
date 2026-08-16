import { describe, it, expect } from "vitest";
import { TASK_TEMPLATES, getTemplate, renderTaskTemplate, validateTemplateParams } from "../../src/pth/kernel/templates";
import { stripTypeScriptTypes } from "node:module";

describe("task templates", () => {
  it("注册表含 3 类模板", () => {
    const ids = TASK_TEMPLATES.map((t) => t.id);
    expect(ids).toContain("recon-doc");
    expect(ids).toContain("memory-maintain");
    expect(ids).toContain("dev-task");
  });

  it("recon-doc 渲染含 url/anchors 且参数 JSON 安全嵌入", () => {
    const code = renderTaskTemplate("recon-doc", {
      url: "https://example.com/doc",
      section: "Types",
      anchors: ["go", "spec"],
      entryId: "go-spec-x",
    })!;
    expect(code).toContain('"https://example.com/doc"');
    expect(code).toContain('"Types"');
    expect(code).toContain('["go","spec"]');
    expect(code).toContain("web.fetchText");
    expect(code).toContain("llm.complete");
    expect(code).toContain("memory.write");
  });

  it("memory-maintain 渲染含检索锚点", () => {
    const code = renderTaskTemplate("memory-maintain", { anchors: ["go"], task: "去重" })!;
    expect(code).toContain('["go"]');
    expect(code).toContain("memory.retrieve");
    expect(code).toContain("去重");
  });

  it("dev-task 渲染 description 经 JSON 转义（防注入）", () => {
    const code = renderTaskTemplate("dev-task", { description: 'print("hi"); # 注释' })!;
    expect(code).toContain("python.execute");
    // description 嵌入为 JSON 字符串字面量（内嵌双引号被转义）
    expect(code).toContain('const description = "print(\\"hi\\"); # 注释";');
  });

  it("生成代码语法合法（interpreter 包装后 stripTypeScriptTypes 可解析）", () => {
    for (const t of TASK_TEMPLATES) {
      // 模板统一收口（A+）：natural-language 模板（系统治理提示词）不经 PTC 语法包装
      if (t.renderKind === "natural-language") continue;
      const code = t.render({ url: "https://x.dev/a", section: "S", anchors: ["a", "b"], entryId: "t-1", kind: "k", task: "整理", description: "print(1)" });
      // interpreter 把任务代码包进 async 函数（顶层 await/return 合法）
      const wrapped = `(async () => { ${code} })()`;
      expect(() => stripTypeScriptTypes(wrapped), t.id).not.toThrow();
    }
  });

  it("validateTemplateParams 缺必填报缺参", () => {
    expect(validateTemplateParams("recon-doc", {})).toContain("url");
    expect(validateTemplateParams("recon-doc", { url: "https://x" })).toEqual([]);
    expect(validateTemplateParams("unknown", {})).toEqual(["unknown-template"]);
  });

  it("getTemplate 未知返回 undefined", () => {
    expect(getTemplate("nope")).toBeUndefined();
  });
});

describe("dev-task-ts 模板", () => {
  it("注册存在", () => {
    expect(getTemplate("dev-task-ts")).toBeDefined();
  });

  it("渲染含 __fn 包装 + memory.write 沉淀", () => {
    const code = renderTaskTemplate("dev-task-ts", { description: "function f(){return 1}\nreturn f();", entryId: "t1" })!;
    expect(code).toContain("__fn = async");
    expect(code).toContain("memory.write");
    expect(code).toContain("globalThis.f = f");   // autoExportBlock 注入
  });

  it("无 return 的用户代码 → 追加导出（不崩）", () => {
    const code = renderTaskTemplate("dev-task-ts", { description: "function g(){return 2}\nconst x = g();", entryId: "t2" })!;
    expect(code).toContain("globalThis.g = g");
  });
});
