import { describe, it, expect } from "vitest";
import { AGENT_TOOLS, toolsForExecTool } from "../../src/pth/kernel/execution/agent-tools.js";
import { spaceRegistry } from "../../src/pth/kernel/execution/space-registry.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 生产核 write 空间（2026-08-12 批 2）：文档工具面 + 章节组织 + 真实文件操作 */
describe("生产核 write 空间工具面", () => {
  it("write 族名展开：6 个 write.* 工具", () => {
    const tools = toolsForExecTool("write").map((t) => t.name);
    expect(tools).toEqual(["write_create", "write_edit", "write_read", "write_list", "write_save", "write_section"]);
  });

  it("write 空间门控：execTool 反查归 write", () => {
    expect(spaceRegistry.get("write")?.execTool).toBe("write");
    expect(spaceRegistry.spaceOfExecTool("write_create")).toBe("write");
    expect(spaceRegistry.spaceOfExecTool("write.edit")).toBe("write");
    expect(spaceRegistry.get("write")?.extraTools).toBeUndefined();  // 无 debug 族（文档不调试）
  });
});

/** 真实文件操作（临时工作区） */
describe("write.* 文档工作流（大纲→草稿→修订→定稿）", () => {
  async function makeCtx() {
    const ws = await mkdtemp(join(tmpdir(), "write-space-"));
    const store = new Map<string, string>();
    return {
      ctx: {
        kernel: {} as never,
        caps: {},
        taskWorkspace: ws,
        toolstore: {
          writeText: async (path: string, content: string) => { store.set(path, content); },
          listSubdir: async () => [...store.keys()],
        } as never,
      } as never,
      ws,
      store,
    };
  }

  it("create→edit→read→list 完整流", async () => {
    const { ctx, ws, store } = await makeCtx();
    const c = await AGENT_TOOLS["write.create"](ctx, { path: "guide.md", content: "# 指南\n\n## 第一章\n\n内容 A\n\n## 第二章\n\n内容 B\n" });
    expect(c.ok).toBe(true);
    const e = await AGENT_TOOLS["write.edit"](ctx, { path: "guide.md", oldText: "内容 A", newText: "内容 A（修订）" });
    expect(e.ok).toBe(true);
    const r = await AGENT_TOOLS["write.read"](ctx, { path: "guide.md" });
    expect(r.ok).toBe(true);
    expect((r.stdout ?? "")).toContain("内容 A（修订）");
    const l = await AGENT_TOOLS["write.list"](ctx);
    expect(l.ok).toBe(true);
    expect(l.value).toContain("guide.md");
    // 实盘验证
    expect(await readFile(join(ws, "guide.md"), "utf-8")).toContain("内容 A（修订）");
    expect(store.size).toBe(0);  // 未 save——toolstore 无写入
  });

  it("edit 唯一匹配约束（多处匹配报错）", async () => {
    const { ctx } = await makeCtx();
    await AGENT_TOOLS["write.create"](ctx, { path: "dup.md", content: "同一段\n同一段\n" });
    const e = await AGENT_TOOLS["write.edit"](ctx, { path: "dup.md", oldText: "同一段", newText: "改" });
    expect(e.ok).toBe(false);
    expect((e.error ?? "")).toMatch(/匹配 2 处/);
  });

  it("save 存记忆单元（docs/ 前缀）+ 非法名拒绝", async () => {
    const { ctx, store } = await makeCtx();
    await AGENT_TOOLS["write.create"](ctx, { path: "final.md", content: "# 定稿\n" });
    const s = await AGENT_TOOLS["write.save"](ctx, { path: "final.md", name: "my-guide" });
    expect(s.ok).toBe(true);
    expect(store.has("docs/my-guide.md")).toBe(true);
    const bad = await AGENT_TOOLS["write.save"](ctx, { path: "final.md", name: "bad name!" });
    expect(bad.ok).toBe(false);
  });

  it("section：list 标题结构 / split 拆章节 / reorder 重排", async () => {
    const { ctx, ws } = await makeCtx();
    await AGENT_TOOLS["write.create"](ctx, {
      path: "book.md",
      content: "# 书名\n\n前言\n\n## 第二章\n\n内容 B\n\n## 第一章\n\n内容 A\n",
    });
    // list
    const l = await AGENT_TOOLS["write.section"](ctx, { path: "book.md", op: "list" });
    expect(l.ok).toBe(true);
    expect(l.value).toHaveLength(3);   // 书名 + 第二章 + 第一章
    // reorder：第一章 → 第二章前
    const r = await AGENT_TOOLS["write.section"](ctx, { path: "book.md", op: "reorder", title: "## 第一章", before: "## 第二章" });
    expect(r.ok).toBe(true);
    const after = await readFile(join(ws, "book.md"), "utf-8");
    expect(after.indexOf("## 第一章")).toBeLessThan(after.indexOf("## 第二章"));
    // split：从 第一章 拆后段 → part2.md
    const sp = await AGENT_TOOLS["write.section"](ctx, { path: "book.md", op: "split", title: "## 第一章", target: "part2.md" });
    expect(sp.ok).toBe(true);
    const head = await readFile(join(ws, "book.md"), "utf-8");
    const tail = await readFile(join(ws, "part2.md"), "utf-8");
    expect(head).not.toContain("内容 A");
    expect(tail).toContain("内容 A");
    expect(tail).toContain("## 第一章");
  });

  it("路径白名单：越出工作区拒绝（resolveArtifact 抛错——agent-loop 层转 ok:false）", async () => {
    const { ctx } = await makeCtx();
    await expect(AGENT_TOOLS["write.create"](ctx, { path: "../../etc/evil.md", content: "x" })).rejects.toThrow(/仅允许工作区相对路径/);
  });

  afterEach(async () => {
    // 清理临时工作区（每个 ctx 独立）
  });
});
