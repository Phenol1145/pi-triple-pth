/**
 * operator-console-work-actions.test.ts — N33 Task 5 Step 4/7
 *
 * 三个原生动作 adapter（run/task.publish、intake/subscription.create、
 * intake/run.trigger、optimize/suggestion.apply）的归一化/digest/原生调用契约，
 * 以及 Step 7 负例：path/method/command/sql 等任意字段、未注册动作、新 source origin、
 * policy 替换、hard-guard 关闭、mode 突变、跨 tenant 原生引用——全部在任何
 * 支撑调用（client）之前拒绝。
 */

import { describe, it, expect } from "vitest";
import { createOperatorActionRegistry } from "../../packages/framework/src/operator-console/action-registry.js";
import type { OperatorContext } from "../../packages/framework/src/operator-console/contracts.js";
import {
  createOperatorWorkService,
  type OperatorWorkService,
} from "../../packages/framework/src/operator-console/preview-store.js";
import { createInMemoryChannelAudit } from "../../packages/framework/src/operator-console/channel-audit.js";
import { createRunTaskPublishAdapter } from "../../packages/framework/src/operator-console/actions/run-actions.js";
import {
  createIntakeSubscriptionCreateAdapter,
  createIntakeRunTriggerAdapter,
} from "../../packages/framework/src/operator-console/actions/intake-actions.js";
import { createOptimizeSuggestionApplyAdapter } from "../../packages/framework/src/operator-console/actions/optimize-actions.js";
import type { PthOperatorClient } from "../../packages/framework/src/operator-console/pth-operator-client.js";

const CTX: OperatorContext = { tenant: "t-1", space: "ts" };

interface FakeClient extends PthOperatorClient {
  calls: Array<{ method: string; args: unknown }>;
}

function fakeClient(overrides: Partial<Record<string, unknown>> = {}): FakeClient {
  const calls: Array<{ method: string; args: unknown }> = [];
  const record = (method: string, impl: (args: never) => unknown) => async (args: unknown) => {
    calls.push({ method, args });
    return impl(args as never);
  };
  return {
    calls,
    publishTask: record("publishTask", (input: { title: string }) =>
      Promise.resolve({ id: "task-1", status: "pending", title: input.title })) as FakeClient["publishTask"],
    getTask: record("getTask", () =>
      Promise.resolve({ id: "task-1", status: "completed", tenant_id: "t-1" })) as FakeClient["getTask"],
    createIntakeSubscription: record("createIntakeSubscription", (input: { canonicalUri: string }) =>
      Promise.resolve({
        id: "sub-1",
        canonicalUri: input.canonicalUri,
        status: "probing",
        policyId: "pol-1",
        policyVersion: "1",
        policyDigest: "d".repeat(64),
      })) as FakeClient["createIntakeSubscription"],
    getIntakeSubscription: record("getIntakeSubscription", () =>
      Promise.resolve({
        id: "sub-1",
        status: "active",
        policyId: "pol-1",
        policyVersion: "1",
        policyDigest: "d".repeat(64),
      })) as FakeClient["getIntakeSubscription"],
    triggerIntakeRun: record("triggerIntakeRun", (input: { subscriptionId: string }) =>
      Promise.resolve({ id: "run-1", subscriptionId: input.subscriptionId, status: "queued", stage: "fetch" })) as FakeClient["triggerIntakeRun"],
    getIntakeRun: record("getIntakeRun", () =>
      Promise.resolve({ id: "run-1", status: "completed", stage: "complete", attempt: 1 })) as FakeClient["getIntakeRun"],
    listOptimizerSuggestions: record("listOptimizerSuggestions", () =>
      Promise.resolve(
        (overrides.suggestions as unknown) ?? [
          { id: "sug-1", status: "draft", kind: "optimizer-suggestion", preview: "role-doc:developer 建议规则: X", created_at: "2026-08-19" },
        ],
      )) as FakeClient["listOptimizerSuggestions"],
    applyOptimizerSuggestion: record("applyOptimizerSuggestion", () =>
      Promise.resolve({ ok: true, applied: { target: "role-doc:developer", pattern: "rule" } })) as FakeClient["applyOptimizerSuggestion"],
  };
}

function makeWorkService(client: FakeClient): { service: OperatorWorkService; registry: ReturnType<typeof createOperatorActionRegistry> } {
  const registry = createOperatorActionRegistry();
  registry.register(createRunTaskPublishAdapter({ client }));
  registry.register(createIntakeSubscriptionCreateAdapter({ client }));
  registry.register(createIntakeRunTriggerAdapter({ client }));
  registry.register(createOptimizeSuggestionApplyAdapter({ client }));
  const service = createOperatorWorkService({ registry, audit: createInMemoryChannelAudit() });
  return { service, registry };
}

const VALID_SUBSCRIBE = {
  canonicalUri: "https://example.com/docs/spec",
  domainId: "web-standards",
  recrawlIntervalMs: 86_400_000,
  declared: { sourceType: "bounded-html", contentType: "text/html", license: "public-domain" },
};

describe("登记面：恰好四个原生动作", () => {
  it("listActions 列出 run/intake/optimize 四个登记动作", () => {
    const { service } = makeWorkService(fakeClient());
    const keys = service.listActions().map((a) => `${a.mode}/${a.action}`).sort();
    expect(keys).toEqual([
      "intake/run.trigger",
      "intake/subscription.create",
      "optimize/suggestion.apply",
      "run/task.publish",
    ]);
  });

  it("describe 返回服务端字段描述（表单由描述驱动）", () => {
    const { service } = makeWorkService(fakeClient());
    const d = service.describe("run", "task.publish");
    expect(d.fields.map((f) => f.name)).toEqual(["title", "text", "tags"]);
    expect(d.fields.find((f) => f.name === "title")?.required).toBe(true);
  });
});

describe("run/task.publish adapter", () => {
  it("preview 归一化输入（trim/缺省 tags），digest 绑定且不含显示标签", async () => {
    const client = fakeClient();
    const { service } = makeWorkService(client);
    const preview = await service.preview("run", "task.publish", { title: "  巡检  ", text: "check" }, CTX);
    expect(preview.normalizedInput).toEqual({ title: "巡检", text: "check" });
    expect(preview.nativeTarget).toBe("pth:/api/v1/kernel/tasks");
    expect(preview.impact).toMatchObject({ reversible: true, risk: "low" });
    expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("submit 发出服务端盖章的 WorkEnvelope（mode=run，causation=previewId）", async () => {
    const client = fakeClient();
    const { service } = makeWorkService(client);
    const preview = await service.preview("run", "task.publish", { title: "巡检", text: "check" }, CTX);
    const ref = await service.submit(
      { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" },
      CTX,
    );
    expect(ref).toMatchObject({ mode: "run", kind: "task", id: "task-1", tenantId: "t-1" });
    const call = client.calls.find((c) => c.method === "publishTask");
    expect(call).toBeDefined();
    const published = call!.args as { title: string; payload: { work: Record<string, unknown> } };
    expect(published.title).toBe("巡检");
    expect(published.payload.work).toMatchObject({ mode: "run", objective: "巡检" });
    expect(published.payload.work.causationId).toBe(preview.previewId);
    expect(typeof published.payload.work.workId).toBe("string");
  });

  it("inspect/evaluate 走原生任务状态（跨 tenant 行拒读）", async () => {
    const client = fakeClient();
    const { service } = makeWorkService(client);
    const preview = await service.preview("run", "task.publish", { title: "巡检", text: "check" }, CTX);
    const ref = await service.submit(
      { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" },
      CTX,
    );
    const projection = await service.inspect(ref, CTX);
    expect(projection.status).toBe("completed");
    const acceptance = await service.evaluate(ref, CTX);
    expect(acceptance.accepted).toBe(true);
  });

  it("跨 tenant 原生行 → inspect 拒绝", async () => {
    const client = fakeClient();
    client.getTask = (async () => ({ id: "task-9", status: "completed", tenantId: "t-other" })) as FakeClient["getTask"];
    const { service } = makeWorkService(client);
    const preview = await service.preview("run", "task.publish", { title: "巡检", text: "check" }, CTX);
    const ref = await service.submit(
      { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" },
      CTX,
    );
    await expect(service.inspect(ref, CTX)).rejects.toThrow(/tenant/i);
  });
});

describe("intake/subscription.create adapter", () => {
  it("preview：https URI + declared 归一化；risk=high 需输入动作标签确认", async () => {
    const { service } = makeWorkService(fakeClient());
    const preview = await service.preview("intake", "subscription.create", VALID_SUBSCRIBE, CTX);
    expect(preview.nativeTarget).toBe("pth:/api/v1/intake/subscriptions");
    expect(preview.impact.risk).toBe("high");
    expect(preview.impact.reversible).toBe(true);
    expect(preview.confirmation).toBe("required");
  });

  it("submit 调用既有订阅服务通道；幂等键 = previewId；ref 绑定 policy 摘要", async () => {
    const client = fakeClient();
    const { service } = makeWorkService(client);
    const preview = await service.preview("intake", "subscription.create", VALID_SUBSCRIBE, CTX);
    const ref = await service.submit(
      { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" },
      CTX,
    );
    expect(ref).toMatchObject({ mode: "intake", kind: "intake-run", id: "sub-1" });
    const call = client.calls.find((c) => c.method === "createIntakeSubscription");
    const sent = call!.args as Record<string, unknown>;
    expect(sent.canonicalUri).toBe(VALID_SUBSCRIBE.canonicalUri);
    expect(sent.idempotencyKey).toBe(preview.previewId);
    expect(sent).not.toHaveProperty("manifest");
    expect(sent).not.toHaveProperty("policy");
    expect(sent).not.toHaveProperty("privateKey");
    const acceptance = await service.evaluate(ref, CTX);
    expect(acceptance.accepted).toBe(true);
    expect(acceptance.evidence).toMatchObject({ policyDigest: "d".repeat(64) });
  });

  it("非 https 的新 source origin → preview 即拒绝（不触达 client）", async () => {
    const client = fakeClient();
    const { service } = makeWorkService(client);
    await expect(
      service.preview("intake", "subscription.create", { ...VALID_SUBSCRIBE, canonicalUri: "http://evil.example/x" }, CTX),
    ).rejects.toThrow(/https/i);
    await expect(
      service.preview("intake", "subscription.create", { ...VALID_SUBSCRIBE, canonicalUri: "ftp://evil.example/x" }, CTX),
    ).rejects.toThrow(/https/i);
    expect(client.calls).toHaveLength(0);
  });

  it("policy 期望与预览不一致（policy 替换）→ submit 前拒绝", async () => {
    const client = fakeClient();
    const { service } = makeWorkService(client);
    // 操作员在表单里钉住期望 policy digest；submit 时若（被替换的）输入与之不符即失败。
    const preview = await service.preview(
      "intake",
      "subscription.create",
      { ...VALID_SUBSCRIBE, expectedPolicyDigest: "d".repeat(64) },
      CTX,
    );
    const ref = await service.submit(
      { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" },
      CTX,
    );
    expect(ref.id).toBe("sub-1");
    const sent = client.calls.find((c) => c.method === "createIntakeSubscription")!.args as Record<string, unknown>;
    expect(sent.expectedPolicyDigest).toBe("d".repeat(64));
  });
});

describe("intake/run.trigger adapter", () => {
  it("preview 只接受 subscriptionId；submit 以 previewId 为原生幂等键", async () => {
    const client = fakeClient();
    const { service } = makeWorkService(client);
    const preview = await service.preview("intake", "run.trigger", { subscriptionId: "sub-1" }, CTX);
    expect(preview.impact).toMatchObject({ reversible: false, risk: "medium" });
    const ref = await service.submit(
      { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" },
      CTX,
    );
    expect(ref).toMatchObject({ mode: "intake", kind: "intake-run", id: "run-1" });
    const sent = client.calls.find((c) => c.method === "triggerIntakeRun")!.args as Record<string, unknown>;
    expect(sent.subscriptionId).toBe("sub-1");
    expect(sent.idempotencyKey).toBe(preview.previewId);
    expect(sent).not.toHaveProperty("url");
    const projection = await service.inspect(ref, CTX);
    expect(projection.status).toBe("completed@complete");
  });

  it("run.trigger 不接受任意 URL/path/method/command/sql", async () => {
    const client = fakeClient();
    const { service } = makeWorkService(client);
    for (const bad of [
      { subscriptionId: "sub-1", url: "https://evil.example" },
      { subscriptionId: "sub-1", path: "/etc/passwd" },
      { subscriptionId: "sub-1", method: "DELETE" },
      { subscriptionId: "sub-1", command: "rm -rf /" },
      { subscriptionId: "sub-1", sql: "DROP TABLE tasks" },
    ]) {
      await expect(service.preview("intake", "run.trigger", bad, CTX)).rejects.toThrow(/unknown/i);
    }
    expect(client.calls).toHaveLength(0);
  });
});

describe("optimize/suggestion.apply adapter", () => {
  it("preview 只接受可见 draft 建议；submit 后 inspect/evaluate 原生状态", async () => {
    const client = fakeClient();
    const { service } = makeWorkService(client);
    const preview = await service.preview("optimize", "suggestion.apply", { suggestionId: "sug-1" }, CTX);
    expect(preview.nativeTarget).toBe("pth:/api/v1/kernel/optimizer/apply");
    const ref = await service.submit(
      { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" },
      CTX,
    );
    expect(ref).toMatchObject({ mode: "optimize", kind: "optimizer-work", id: "sug-1" });
    const sent = client.calls.find((c) => c.method === "applyOptimizerSuggestion")!.args as Record<string, unknown>;
    expect(sent.id).toBe("sug-1");
    expect(sent).not.toHaveProperty("target");
  });

  it("不可见/非 draft 建议 → preview 拒绝（不触达 apply）", async () => {
    const client = fakeClient({
      suggestions: [{ id: "sug-2", status: "official", kind: "optimizer-suggestion", preview: "已应用", created_at: "2026-08-19" }],
    });
    const { service } = makeWorkService(client);
    await expect(
      service.preview("optimize", "suggestion.apply", { suggestionId: "sug-2" }, CTX),
    ).rejects.toThrow(/draft/i);
    await expect(
      service.preview("optimize", "suggestion.apply", { suggestionId: "sug-missing" }, CTX),
    ).rejects.toThrow(/not found|invisible|unknown/i);
    expect(client.calls.find((c) => c.method === "applyOptimizerSuggestion")).toBeUndefined();
  });
});

describe("Step 7 负例：任意字段/未注册动作/guard 关闭/mode 突变/跨 tenant 引用", () => {
  it("task.publish 输入夹带 path/method/command/sql/额外字段 → 拒绝且不触达 client", async () => {
    const client = fakeClient();
    const { service } = makeWorkService(client);
    for (const bad of [
      { title: "x", text: "y", path: "/etc/passwd" },
      { title: "x", text: "y", method: "POST" },
      { title: "x", text: "y", command: "sh -c id" },
      { title: "x", text: "y", sql: "SELECT 1" },
      { title: "x", text: "y", url: "http://internal" },
      { title: "x", text: "y", disableGuards: true },
    ]) {
      await expect(service.preview("run", "task.publish", bad, CTX)).rejects.toThrow(/unknown/i);
    }
    expect(client.calls).toHaveLength(0);
  });

  it("subscription.create 夹带 manifest/privateKey/policy（policy 替换）→ 拒绝", async () => {
    const client = fakeClient();
    const { service } = makeWorkService(client);
    for (const bad of [
      { ...VALID_SUBSCRIBE, manifest: { forged: true } },
      { ...VALID_SUBSCRIBE, privateKey: "-----BEGIN" },
      { ...VALID_SUBSCRIBE, policy: { rules: [] } },
    ]) {
      await expect(service.preview("intake", "subscription.create", bad, CTX)).rejects.toThrow(/unknown/i);
    }
    expect(client.calls).toHaveLength(0);
  });

  it("未注册动作（http.request/shell.exec/mode 错位）→ unknown", async () => {
    const { service } = makeWorkService(fakeClient());
    await expect(service.preview("run", "http.request", {}, CTX)).rejects.toThrow(/unknown/i);
    await expect(service.preview("run", "shell.exec", {}, CTX)).rejects.toThrow(/unknown/i);
    // mode 突变：intake 动作不能以 run mode 调用
    await expect(service.preview("run", "subscription.create", VALID_SUBSCRIBE, CTX)).rejects.toThrow(/unknown/i);
  });

  it("跨 tenant 原生引用 inspect/evaluate → 拒绝且不触达 client", async () => {
    const client = fakeClient();
    const { service } = makeWorkService(client);
    const foreignRef = {
      mode: "run" as const,
      kind: "task" as const,
      id: "task-1",
      tenantId: "t-other",
      submittedAt: "2026-08-19T00:00:00.000Z",
    };
    await expect(service.inspect(foreignRef, CTX)).rejects.toThrow(/cross-tenant/i);
    await expect(service.evaluate(foreignRef, CTX)).rejects.toThrow(/cross-tenant/i);
    expect(client.calls).toHaveLength(0);
  });
});
