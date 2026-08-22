import { describe, expect, it } from "vitest";
import {
  MCP_BUNDLE_FORMAT,
  importMcpTools,
  mcpToolToSpec,
  parseMcpBundle,
  type McpBundleTool,
  type McpToolBundle,
} from "@away_from/pth-kernel-interpreter";
import type { MemoryEntry } from "@away_from/pth-memory";

function tool(over: Partial<McpBundleTool> = {}): McpBundleTool {
  return {
    name: "parse_log",
    description: "解析日志首列时间戳",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    source: "function parseLog(text) { const m = text.match(/\\d+/g); return m ?? []; }",
    call: "parseLog(String(args.text))",
    ...over,
  };
}

function bundle(over: Partial<McpToolBundle> = {}): McpToolBundle {
  return { format: MCP_BUNDLE_FORMAT, server: "example-server", tools: [tool()], ...over };
}

/** 捕获型 fake store（与 ToolRegGovernanceStore 结构同形） */
function fakeStore(entries: Record<string, MemoryEntry> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    store: {
      get: async (id: string) => map.get(id),
      write: async (entry: MemoryEntry) => {
        map.set(entry.id, { ...entry });
      },
      update: async (id: string, patch: Partial<MemoryEntry>) => {
        const prev = map.get(id);
        if (!prev) throw new Error(`entry not found: ${id}`);
        map.set(id, { ...prev, ...patch, meta: { ...(prev.meta ?? {}), ...(patch.meta ?? {}) } });
      },
    },
  };
}

describe("D1 parseMcpBundle：错误全量收集", () => {
  it("非对象 bundle → 只报对象错误", () => {
    for (const raw of [null, "bundle", 42, []]) {
      const r = parseMcpBundle(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join("\n")).toContain("bundle 必须是对象");
    }
  });

  it("format/server/tools 逐条拒绝且错误可读", () => {
    const r = parseMcpBundle({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("\n")).toContain(`format 应为 "${MCP_BUNDLE_FORMAT}"`);
    expect(r.errors.join("\n")).toContain("server 必填");
    expect(r.errors.join("\n")).toContain("tools 必须为非空数组");
  });

  it("server 长度/字符集校验（≤64，[a-z0-9][a-z0-9._-]*）", () => {
    const long = parseMcpBundle(bundle({ server: "a".repeat(65) }));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.errors.join("\n")).toContain("server 非法");

    const upper = parseMcpBundle(bundle({ server: "Example-Server" }));
    expect(upper.ok).toBe(false);
    if (!upper.ok) expect(upper.errors.join("\n")).toContain("server 非法");

    expect(parseMcpBundle(bundle({ server: "example-server_1" })).ok).toBe(true);
  });

  it("tools 非数组/空数组 → 拒绝", () => {
    const notArray = parseMcpBundle(bundle({ tools: "x" as never }));
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) expect(notArray.errors.join("\n")).toContain("tools 必须为非空数组");

    const empty = parseMcpBundle(bundle({ tools: [] }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors.join("\n")).toContain("tools 必须为非空数组");
  });

  it("tool name 非空且匹配 TOOL_REG_NAME_RE", () => {
    const missing = parseMcpBundle(bundle({ tools: [tool({ name: "" })] }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join("\n")).toContain("tools[0].name 必填");

    const bad = parseMcpBundle(bundle({ tools: [tool({ name: "Parse_Log" })] }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join("\n")).toContain("tools[0].name 非法");
  });

  it("source 空 / 代码层 import/require 拒绝；字符串/注释不误拒", () => {
    const empty = parseMcpBundle(bundle({ tools: [tool({ source: "" })] }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors.join("\n")).toContain("tools[0].source 必填");

    const importCode = parseMcpBundle(bundle({ tools: [tool({ source: "import fs from 'fs';" })] }));
    expect(importCode.ok).toBe(false);
    if (!importCode.ok) expect(importCode.errors.join("\n")).toContain("import/require");

    const requireCode = parseMcpBundle(bundle({ tools: [tool({ source: "const fs = require('fs');" })] }));
    expect(requireCode.ok).toBe(false);
    if (!requireCode.ok) expect(requireCode.errors.join("\n")).toContain("import/require");

    const onlyText = parseMcpBundle(bundle({
      tools: [tool({
        source: [
          "const s = 'import fs from \"fs\";';",
          "const t = \"require('fs')\";",
          "// import fs from 'fs';",
          "/* require('fs') */",
          "const important = 1; const requires = 2;",
          "function parseLog(text) { return text; }",
        ].join("\n"),
      })],
    }));
    expect(onlyText.ok).toBe(true);
  });

  it("call 空 → 拒绝", () => {
    const r = parseMcpBundle(bundle({ tools: [tool({ call: "" })] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("tools[0].call 必填");
  });

  it("inputSchema 坏 schema 逐条拒绝；合法/缺省通过", () => {
    const badType = parseMcpBundle(bundle({ tools: [tool({ inputSchema: { type: "array", properties: {} } })] }));
    expect(badType.ok).toBe(false);
    if (!badType.ok) expect(badType.errors.join("\n")).toContain("inputSchema.type");

    const badProps = parseMcpBundle(bundle({ tools: [tool({ inputSchema: { type: "object", properties: [] } })] }));
    expect(badProps.ok).toBe(false);
    if (!badProps.ok) expect(badProps.errors.join("\n")).toContain("inputSchema.properties");

    const badRequired = parseMcpBundle(bundle({
      tools: [tool({
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text", "nope"] },
      })],
    }));
    expect(badRequired.ok).toBe(false);
    if (!badRequired.ok) expect(badRequired.errors.join("\n")).toContain("nope");

    const noRequired = parseMcpBundle(bundle({ tools: [tool({ inputSchema: { type: "object", properties: { text: { type: "string" } } } })] }));
    expect(noRequired.ok).toBe(true);

    const noSchema = parseMcpBundle(bundle({ tools: [tool({ inputSchema: undefined })] }));
    expect(noSchema.ok).toBe(true);
  });

  it("roles/pack 若提供必须合法", () => {
    const emptyRoles = parseMcpBundle(bundle({ tools: [tool({ roles: [] })] }));
    expect(emptyRoles.ok).toBe(false);
    if (!emptyRoles.ok) expect(emptyRoles.errors.join("\n")).toContain("roles");

    const badRoles = parseMcpBundle(bundle({ tools: [tool({ roles: ["", "developer"] })] }));
    expect(badRoles.ok).toBe(false);
    if (!badRoles.ok) expect(badRoles.errors.join("\n")).toContain("roles");

    const emptyPack = parseMcpBundle(bundle({ tools: [tool({ pack: "" })] }));
    expect(emptyPack.ok).toBe(false);
    if (!emptyPack.ok) expect(emptyPack.errors.join("\n")).toContain("pack");

    expect(parseMcpBundle(bundle({ tools: [tool({ roles: ["developer"], pack: "util" })] })).ok).toBe(true);
  });

  it("合法 bundle 全量通过", () => {
    const r = parseMcpBundle(bundle({
      tools: [tool(), tool({ name: "upper", description: "转大写", roles: ["coder"], pack: "text" })],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.tools).toHaveLength(2);
    expect(r.bundle.server).toBe("example-server");
  });
});

describe("D1 mcpToolToSpec：spec 生成契约", () => {
  it("version=1 + executor 尾调用拼接 + promotedFrom 前缀", () => {
    const r = mcpToolToSpec(tool(), "example-server");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.version).toBe(1);
    expect(r.spec.executor).toEqual({
      type: "program",
      source: `${tool().source}\nreturn ${tool().call};`,
    });
    expect(r.spec.promotedFrom).toBe("mcp:example-server/parse_log");
    expect(r.spec.parameters).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
  });

  it("三要素缺省派生（含 description 首句 ≤80）与显式覆盖", () => {
    const noDesc = mcpToolToSpec(tool({ description: undefined, anchor: undefined, whenToUse: undefined, effect: undefined }), "example-server");
    expect(noDesc.ok).toBe(true);
    if (!noDesc.ok) return;
    expect(noDesc.spec.description).toEqual({
      anchor: "example-server/parse_log——MCP 拆解工具",
      whenToUse: "需要调用该 MCP 工具能力时",
      effect: "返回 parse_log 的工具调用结果（program 态——ts 核执行）",
    });
    expect(noDesc.spec.visibility).toEqual({ roles: ["developer", "coder"], pack: "mcp-example-server" });

    const withDesc = mcpToolToSpec(tool({ anchor: undefined, whenToUse: undefined, effect: undefined }), "example-server");
    expect(withDesc.ok).toBe(true);
    if (!withDesc.ok) return;
    expect(withDesc.spec.description).toEqual({
      anchor: "example-server/parse_log——解析日志首列时间戳",
      whenToUse: "解析日志首列时间戳",
      effect: "返回 parse_log 的工具调用结果（program 态——ts 核执行）",
    });

    const longDesc = mcpToolToSpec(tool({ description: "a".repeat(200), anchor: undefined, whenToUse: undefined }), "srv");
    expect(longDesc.ok).toBe(true);
    if (!longDesc.ok) return;
    expect(longDesc.spec.description.anchor).toBe(`srv/parse_log——${"a".repeat(80)}`);
    expect(longDesc.spec.description.whenToUse).toBe("a".repeat(80));

    const multiSentence = mcpToolToSpec(tool({ description: "第一句。第二句", anchor: undefined, whenToUse: undefined }), "srv");
    expect(multiSentence.ok).toBe(true);
    if (!multiSentence.ok) return;
    expect(multiSentence.spec.description.anchor).toBe("srv/parse_log——第一句。");
    expect(multiSentence.spec.description.whenToUse).toBe("第一句。");

    const explicit = mcpToolToSpec(tool({ anchor: "A", whenToUse: "W", effect: "E", roles: ["developer"], pack: "util" }), "example-server");
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.spec.description).toEqual({ anchor: "A", whenToUse: "W", effect: "E" });
    expect(explicit.spec.visibility).toEqual({ roles: ["developer"], pack: "util" });
  });
});

describe("D1 importMcpTools：批量落 draft 提案（不直写 official）", () => {
  it("每条落 draft tool-proposal；不落 tool-reg official", async () => {
    const { map, store } = fakeStore();
    const r = await importMcpTools(store, bundle({
      tools: [tool(), tool({ name: "upper", description: "转大写" })],
    }));
    expect(r.failed).toEqual([]);
    expect(r.imported).toHaveLength(2);
    expect(r.imported[0]).toMatchObject({ name: "parse_log", proposalId: expect.stringMatching(/^tool-proposal:/) as never });
    expect(r.imported[1]).toMatchObject({ name: "upper", proposalId: expect.stringMatching(/^tool-proposal:/) as never });

    const entries = [...map.values()];
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.kind === "tool-proposal" && e.status === "draft")).toBe(true);
    expect(entries.some((e) => e.kind === "tool-reg")).toBe(false);

    for (const e of entries) {
      const content = JSON.parse(e.content) as { action: string; name: string; spec: { promotedFrom?: string } };
      expect(content.action).toBe("register");
      expect(content.spec.promotedFrom?.startsWith("mcp:example-server/")).toBe(true);
    }
  });

  it("同 bundle 重名第二条 failed 不中断后续", async () => {
    const { map, store } = fakeStore();
    const r = await importMcpTools(store, bundle({
      tools: [tool(), tool(), tool({ name: "upper", description: "转大写" })],
    }));
    expect(r.imported.map((x) => x.name)).toEqual(["parse_log", "upper"]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ name: "parse_log", error: expect.stringContaining("重复") as never });
    expect([...map.values()]).toHaveLength(2);
  });

  it("已有 official tool:<name> → propose 失败记 failed，不中断后续", async () => {
    const existing: MemoryEntry = {
      id: "tool:parse_log",
      kind: "tool-reg",
      anchors: ["tool-reg", "parse_log"],
      content: "x",
      status: "official",
      meta: { version: 1 },
    };
    const { store } = fakeStore({ "tool:parse_log": existing });
    const r = await importMcpTools(store, bundle({
      tools: [tool(), tool({ name: "upper", description: "转大写" })],
    }));
    expect(r.imported.map((x) => x.name)).toEqual(["upper"]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ name: "parse_log", error: expect.stringContaining("已存在") as never });
  });
});
