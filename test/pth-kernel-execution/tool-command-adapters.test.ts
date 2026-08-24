import { describe, it, expect } from "vitest";
import {
  CommandAdapterRegistry,
  agentAdapter,
  analyzeCustomAdapterSource,
  builtinAdapter,
  createDefaultTargetResolver,
  externalAdapter,
  normalizeExecutionRequestToCommand,
  programAdapter,
  renderArgv,
  validateArgvTemplate,
} from "@away_from/pth-kernel-execution";

describe("CommandAdapterRegistry / standard adapters", () => {
  it("builtinAdapter → internal request", () => {
    const adapter = builtinAdapter("dev_read");
    const r = adapter({ path: "a" });
    expect(r.kind).toBe("request");
    if (r.kind === "request") {
      expect(r.request).toMatchObject({ kind: "internal", capability: "dev_read", tool: "dev_read" });
    }
  });

  it("externalAdapter 渲染 argv 数组（永不拼 shell）", () => {
    const adapter = externalAdapter({
      ref: "git-clone",
      argvTemplate: ["git", "clone", "{{url}}", "{{dest}}"],
      parameters: { properties: { url: {}, dest: {} }, required: ["url", "dest"] },
      domain: "network",
    });
    const r = adapter({ url: "https://example.com/repo.git", dest: "repo" });
    expect(r.kind).toBe("request");
    if (r.kind === "request" && r.request.kind === "external") {
      expect(r.request.argv).toEqual(["git", "clone", "https://example.com/repo.git", "repo"]);
      expect(r.request.target).toBe("sandbox");
    }
  });

  it("externalAdapter 缺 required 槽 → deny adapter-config", () => {
    const adapter = externalAdapter({
      ref: "git-clone",
      argvTemplate: ["git", "clone", "{{url}}"],
      parameters: { properties: { url: {} }, required: ["url"] },
    });
    const r = adapter({});
    expect(r.kind).toBe("deny");
    if (r.kind === "deny") {
      expect(r.feedback?.class).toBe("adapter-config");
      expect(r.feedback?.code).toBe("ADAPTER_ARGV_MISSING_SLOT");
    }
  });

  it("target 解析失败 → deny target-resolution", () => {
    const adapter = externalAdapter({
      ref: "x",
      argvTemplate: ["{{path}}"],
      parameters: { properties: { path: {} }, required: ["path"] },
      resolver: {
        resolve: () => ({ ok: false as const, error: "no target" }),
      },
    });
    const r = adapter({ path: "a" });
    expect(r.kind).toBe("deny");
    if (r.kind === "deny") expect(r.feedback?.class).toBe("target-resolution");
  });

  it("dash-prefixed slot value 默认拒绝", () => {
    const adapter = externalAdapter({
      ref: "x",
      argvTemplate: ["tool", "{{value}}"],
      parameters: { properties: { value: {} }, required: ["value"] },
    });
    const r = adapter({ value: "--dangerous" });
    expect(r.kind).toBe("deny");
    if (r.kind === "deny") expect(r.feedback?.code).toBe("ADAPTER_ARGV_DASH_VALUE");
  });

  it("allowDashValues 可显式放行", () => {
    const adapter = externalAdapter({
      ref: "x",
      argvTemplate: ["tool", "{{value}}"],
      parameters: { properties: { value: {} }, required: ["value"] },
      domain: "network",
      allowDashValues: true,
    });
    const r = adapter({ value: "--ok" });
    expect(r.kind).toBe("request");
    if (r.kind === "request" && r.request.kind === "external") expect(r.request.argv[1]).toBe("--ok");
  });

  it("programAdapter → language ts request；agentAdapter → agent request", () => {
    const p = programAdapter("return 1;");
    const pr = p({});
    expect(pr.kind).toBe("request");
    if (pr.kind === "request") expect(pr.request).toMatchObject({ kind: "language", language: "ts" });

    const a = agentAdapter({ role: "executor" });
    const ar = a({});
    expect(ar.kind).toBe("request");
    if (ar.kind === "request") expect(ar.request).toMatchObject({ kind: "agent", role: "executor" });
  });

  it("registry：未注册 → adapter-not-found；重复注册拒绝", () => {
    const reg = new CommandAdapterRegistry();
    reg.register("builtin:dev_read", builtinAdapter("dev_read"));
    const r = reg.call("builtin:missing", {});
    expect(r.kind).toBe("deny");
    if (r.kind === "deny") expect(r.feedback?.class).toBe("adapter-not-found");
    expect(() => reg.register("builtin:dev_read", builtinAdapter("dev_read"))).toThrow(/already registered/);
  });

  it("validateArgvTemplate 缺槽报错", () => {
    const r = validateArgvTemplate(["{{missing}}"], { properties: { path: {} }, required: ["path"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("; ")).toContain('"missing"');
  });

  it("renderArgv 可选槽未提供时跳过该段", () => {
    const r = renderArgv(["cmd", "{{optional}}"], {}, { properties: { optional: {} }, required: [] });
    expect(r).toEqual({ ok: true, argv: ["cmd"] });
  });

  it("自定义 adapter 静态分析拒绝危险模式", () => {
    expect(analyzeCustomAdapterSource("const x = require('fs');").ok).toBe(false);
    expect(analyzeCustomAdapterSource("return 1;").ok).toBe(true);
  });

  it("createDefaultTargetResolver：显式 target > backend > domain > fail-closed", () => {
    const resolver = createDefaultTargetResolver();
    expect(resolver.resolve({ target: "t", backend: "b", domain: "compiled" })).toEqual({ ok: true, target: "t" });
    expect(resolver.resolve({ backend: "b" })).toEqual({ ok: true, target: "b" });
    expect(resolver.resolve({ domain: "compiled" })).toEqual({ ok: true, target: "engine-ts" });
    expect(resolver.resolve({}).ok).toBe(false);
  });

  it("normalizeExecutionRequestToCommand 把 adapter 请求规范化为 ExecutionCommand", () => {
    const security = { principalId: "worker:x", tenantId: "t", roleId: "r" };
    const lang = normalizeExecutionRequestToCommand({ kind: "language", tool: "ts.run", language: "ts", code: "1+1", target: "engine-ts" }, security, "id-1");
    expect(lang).toMatchObject({ kind: "language", id: "id-1", target: "engine-ts", security });
    const ext = normalizeExecutionRequestToCommand({ kind: "external", tool: "git", argv: ["git", "clone", "u"], target: "sandbox" }, security, "id-2");
    expect(ext).toMatchObject({ kind: "external", argv: ["git", "clone", "u"] });
    const agent = normalizeExecutionRequestToCommand({ kind: "agent", tool: "agent:executor", role: "executor" }, security, "id-3");
    expect(agent).toMatchObject({ kind: "agent", role: "executor" });
    const internal = normalizeExecutionRequestToCommand({ kind: "internal", tool: "dev_read", capability: "dev_read", args: { path: "a" } }, security, "id-4");
    expect(internal).toMatchObject({ kind: "internal", capability: "dev_read" });
  });
});
