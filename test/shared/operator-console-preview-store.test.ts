/**
 * operator-console-preview-store.test.ts — N33 Task 5 Step 1
 *
 * 一次性预览契约：
 *  - preview → submit 正常闭环（digest 绑定、tenant/space 绑定）；
 *  - digest 不匹配 / 过期 / 已消费（重放）一律在任何原生调用之前拒绝；
 *  - 幂等：同一 idempotencyKey + 同一 digest 在「歧义网络超时」后重试返回同一个
 *    native ref；同一 key 配不同 digest → 冲突拒绝；
 *  - pending 预览上限（100）与 TTL（15 分钟）；
 *  - 通道审计：preview/submit/submit-confirmed/submit-failed 各落一条固定字段记录。
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createOperatorActionRegistry,
  type OperatorModeAdapter,
} from "../../packages/pth-console/src/operator-console/action-registry.js";
import type {
  NativeWorkRef,
  OperatorCommandPreview,
  OperatorContext,
  OperatorFormDescriptor,
} from "../../packages/pth-console/src/operator-console/contracts.js";
import {
  createOperatorWorkService,
  OPERATOR_MAX_PENDING_PREVIEWS,
  OPERATOR_PREVIEW_TTL_MS,
} from "../../packages/pth-console/src/operator-console/preview-store.js";
import {
  createInMemoryChannelAudit,
  createOperatorChannelAudit,
  type OperatorChannelAudit,
} from "../../packages/pth-console/src/operator-console/channel-audit.js";

const CTX: OperatorContext = { tenant: "t-1", space: "ts" };

function makeRef(id = "task-1"): NativeWorkRef {
  return {
    mode: "run",
    kind: "task",
    id,
    tenantId: "t-1",
    submittedAt: "2026-08-19T00:00:00.000Z",
  };
}

interface FakeAdapterOpts {
  readonly nativeKind?: NativeWorkRef["kind"];
  readonly clock?: () => number;
  readonly submitBehavior?: (preview: OperatorCommandPreview) => Promise<NativeWorkRef>;
}

function fakeAdapter(opts: FakeAdapterOpts = {}): OperatorModeAdapter & { nativeKind: string } {
  const clock = opts.clock ?? (() => Date.now());
  const descriptor: OperatorFormDescriptor = {
    title: "发布任务",
    fields: [{ name: "title", type: "string", required: true }],
  };
  return {
    mode: "run",
    action: "task.publish",
    nativeKind: opts.nativeKind ?? "task",
    describe: () => descriptor,
    async preview(input, context) {
      const { canonicalPreviewDigest } = await import(
        "../../packages/pth-console/src/operator-console/contracts.js"
      );
      const normalizedInput = { title: String((input as Record<string, unknown>).title ?? "") };
      const expiresAt = new Date(clock() + OPERATOR_PREVIEW_TTL_MS).toISOString();
      const digest = canonicalPreviewDigest(
        {
          mode: "run",
          action: "task.publish",
          normalizedInput,
          nativeTarget: "pth:/api/v1/kernel/tasks",
          impact: { scope: "kernel task queue", reversible: true, risk: "low" },
          expiresAt,
        },
        context,
      );
      return {
        previewId: `pv-${digest.slice(0, 12)}`,
        mode: "run",
        action: "task.publish",
        normalizedInput,
        summary: [`发布任务：${normalizedInput.title}`],
        impact: { scope: "kernel task queue", reversible: true, risk: "low" },
        nativeTarget: "pth:/api/v1/kernel/tasks",
        previewDigest: digest,
        expiresAt,
        confirmation: "required",
      };
    },
    submit: opts.submitBehavior ?? (async () => makeRef()),
    async inspect(ref) {
      return { ref, status: "pending", observedAt: new Date().toISOString() };
    },
    async evaluate(ref) {
      return { ref, accepted: true, evidence: { status: "completed" } };
    },
  };
}

function makeService(opts: {
  clock?: () => number;
  audit?: OperatorChannelAudit;
  adapter?: OperatorModeAdapter;
} = {}) {
  const registry = createOperatorActionRegistry();
  registry.register(
    opts.adapter ?? fakeAdapter(opts.clock ? { clock: opts.clock } : {}),
  );
  const audit = opts.audit ?? createInMemoryChannelAudit();
  const service = createOperatorWorkService({
    registry,
    audit,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  return { service, audit, registry };
}

describe("operator preview store：一次性预览闭环", () => {
  it("preview → submit 正常闭环，返回 task 原生引用", async () => {
    const { service } = makeService();
    const preview = await service.preview("run", "task.publish", { title: "x" }, CTX);
    expect(preview.confirmation).toBe("required");
    expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    const ref = await service.submit(
      { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" },
      CTX,
    );
    expect(ref).toMatchObject({ kind: "task", mode: "run" });
  });

  it("成功后用另一 key 重放同一 preview → consumed 拒绝", async () => {
    const { service } = makeService();
    const preview = await service.preview("run", "task.publish", { title: "x" }, CTX);
    await service.submit(
      { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" },
      CTX,
    );
    await expect(
      service.submit(
        { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k2" },
        CTX,
      ),
    ).rejects.toThrow(/consumed/i);
  });

  it("digest 不匹配 → 在任何原生调用之前拒绝", async () => {
    let nativeCalls = 0;
    const adapter = fakeAdapter({
      submitBehavior: async () => {
        nativeCalls += 1;
        return makeRef();
      },
    });
    const { service } = makeService({ adapter });
    const preview = await service.preview("run", "task.publish", { title: "x" }, CTX);
    const forged = `${"0".repeat(63)}1`;
    await expect(
      service.submit({ previewId: preview.previewId, previewDigest: forged, idempotencyKey: "k1" }, CTX),
    ).rejects.toThrow(/digest/i);
    expect(nativeCalls).toBe(0);
  });

  it("过期 preview → 拒绝（TTL 15 分钟，注入时钟）", async () => {
    let now = 1_000_000;
    const { service } = makeService({ clock: () => now });
    const preview = await service.preview("run", "task.publish", { title: "x" }, CTX);
    now += OPERATOR_PREVIEW_TTL_MS + 1;
    await expect(
      service.submit(
        { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" },
        CTX,
      ),
    ).rejects.toThrow(/expired/i);
  });

  it("未知 previewId → 拒绝", async () => {
    const { service } = makeService();
    await expect(
      service.submit({ previewId: "pv-missing", previewDigest: "0".repeat(64), idempotencyKey: "k1" }, CTX),
    ).rejects.toThrow(/unknown preview/i);
  });

  it("跨 tenant 上下文提交 → 拒绝（digest 含 tenant/space 绑定）", async () => {
    const { service } = makeService();
    const preview = await service.preview("run", "task.publish", { title: "x" }, CTX);
    await expect(
      service.submit(
        { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" },
        { tenant: "t-2", space: "ts" },
      ),
    ).rejects.toThrow(/digest|tenant/i);
  });

  it("歧义网络超时后：同 key 同 digest 重试返回同一 native ref", async () => {
    let calls = 0;
    const stableRef = makeRef("task-ambiguous");
    const adapter = fakeAdapter({
      submitBehavior: async () => {
        calls += 1;
        if (calls === 1) {
          // 模拟：原生侧已受理但响应在网络层丢失（歧义）
          throw new Error("network timeout after native accept");
        }
        return stableRef;
      },
    });
    const { service } = makeService({ adapter });
    const preview = await service.preview("run", "task.publish", { title: "x" }, CTX);
    await expect(
      service.submit(
        { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k-amb" },
        CTX,
      ),
    ).rejects.toThrow(/timeout/i);
    const retried = await service.submit(
      { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k-amb" },
      CTX,
    );
    expect(retried).toEqual(stableRef);
    // 幂等恢复后再按 key 查询：直接返回已确认的同一 ref，不再触达原生面
    const lookedUp = await service.submit(
      { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k-amb" },
      CTX,
    );
    expect(lookedUp).toEqual(stableRef);
    expect(calls).toBe(2);
  });

  it("同一 idempotencyKey 配不同 digest → 冲突拒绝", async () => {
    const { service } = makeService();
    const first = await service.preview("run", "task.publish", { title: "a" }, CTX);
    await service.submit(
      { previewId: first.previewId, previewDigest: first.previewDigest, idempotencyKey: "k-dup" },
      CTX,
    );
    const second = await service.preview("run", "task.publish", { title: "b" }, CTX);
    await expect(
      service.submit(
        { previewId: second.previewId, previewDigest: second.previewDigest, idempotencyKey: "k-dup" },
        CTX,
      ),
    ).rejects.toThrow(/conflict/i);
  });

  it("submitting 中的 preview 拒绝用另一 key 抢跑", async () => {
    let release: (ref: NativeWorkRef) => void = () => {};
    const adapter = fakeAdapter({
      submitBehavior: () =>
        new Promise<NativeWorkRef>((resolve) => {
          release = resolve;
        }),
    });
    const { service } = makeService({ adapter });
    const preview = await service.preview("run", "task.publish", { title: "x" }, CTX);
    const inflight = service.submit(
      { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" },
      CTX,
    );
    await expect(
      service.submit(
        { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k2" },
        CTX,
      ),
    ).rejects.toThrow(/consumed|submitting|in.?flight/i);
    release(makeRef());
    await inflight;
  });

  it("pending 预览上限：第 101 个 preview 拒绝", async () => {
    const { service } = makeService();
    for (let i = 0; i < OPERATOR_MAX_PENDING_PREVIEWS; i += 1) {
      await service.preview("run", "task.publish", { title: `t-${i}` }, CTX);
    }
    await expect(service.preview("run", "task.publish", { title: "overflow" }, CTX)).rejects.toThrow(
      /pending|limit|too many/i,
    );
  });

  it("未注册动作 → unknown 拒绝", async () => {
    const { service } = makeService();
    await expect(service.preview("run", "http.request", {}, CTX)).rejects.toThrow(/unknown/i);
    await expect(service.preview("run", "shell.exec", {}, CTX)).rejects.toThrow(/unknown/i);
  });

  it("通道审计：preview/submit/submit-confirmed 各落一条固定字段记录", async () => {
    const audit = createInMemoryChannelAudit();
    const { service } = makeService({ audit });
    const preview = await service.preview("run", "task.publish", { title: "x" }, CTX);
    await service.submit(
      { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" },
      CTX,
    );
    const entries = await audit.readAll();
    const events = entries.map((e) => e.event);
    expect(events).toContain("preview");
    expect(events).toContain("submit");
    expect(events).toContain("submit-confirmed");
    for (const entry of entries) {
      expect(entry.tenant).toBe("t-1");
      expect(entry.mode).toBe("run");
      expect(entry.action).toBe("task.publish");
      // 固定字段面：不得夹带输入正文/secret
      expect(Object.keys(entry).sort()).toEqual(
        ["action", "at", "channel", "event", "mode", "space", "tenant"]
          .concat(
            entry.previewId !== undefined
              ? ["nativeId", "nativeKind", "previewDigest", "previewId"].filter(
                  (k) => (entry as unknown as Record<string, unknown>)[k] !== undefined,
                )
              : [],
          )
          .sort(),
      );
    }
  });

  it("submit 失败落 submit-failed 审计（归一化 errorCode，不含错误正文）", async () => {
    const audit = createInMemoryChannelAudit();
    const adapter = fakeAdapter({
      submitBehavior: async () => {
        throw new Error("connection refused to http://pth-internal:3000/secret-path");
      },
    });
    const { service } = makeService({ audit, adapter });
    const preview = await service.preview("run", "task.publish", { title: "x" }, CTX);
    await expect(
      service.submit(
        { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" },
        CTX,
      ),
    ).rejects.toThrow();
    const failed = (await audit.readAll()).find((e) => e.event === "submit-failed");
    expect(failed).toBeDefined();
    expect(failed!.errorCode).toBe("NATIVE_SUBMIT_ERROR");
    expect(JSON.stringify(failed)).not.toContain("secret-path");
  });
});

describe("channel-audit：append-only JSONL（0600/O_APPEND/fsync/截断容错）", () => {
  function tempAuditPath(): string {
    return path.join(mkdtempSync(path.join(tmpdir(), "ptl-audit-")), "channel.jsonl");
  }

  it("记录落盘后可读回；文件权限 0600", async () => {
    const filePath = tempAuditPath();
    const audit = createOperatorChannelAudit({ filePath });
    await audit.record({
      at: "2026-08-19T00:00:00.000Z",
      channel: "work",
      event: "preview",
      mode: "run",
      action: "task.publish",
      tenant: "t-1",
      space: "ts",
      previewId: "pv-1",
      previewDigest: "0".repeat(64),
    });
    const entries = await audit.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: "preview", previewId: "pv-1" });
    const { statSync } = await import("node:fs");
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("崩溃截断的最后一行在读取时被忽略；完整行不受影响", async () => {
    const filePath = tempAuditPath();
    const audit = createOperatorChannelAudit({ filePath });
    const base = {
      at: "2026-08-19T00:00:00.000Z",
      channel: "work" as const,
      mode: "run" as const,
      action: "task.publish",
      tenant: "t-1",
      space: "ts",
    };
    await audit.record({ ...base, event: "preview", previewId: "pv-1", previewDigest: "0".repeat(64) });
    await audit.record({ ...base, event: "submit", previewId: "pv-1", previewDigest: "0".repeat(64) });
    const { appendFileSync } = await import("node:fs");
    appendFileSync(filePath, '{"at":"2026-08-19T00:00:01.000Z","channel":"work","eve'); // 截断行
    const entries = await audit.readAll();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.event)).toEqual(["preview", "submit"]);
    // 截断行之后仍 append-only 可写：写入侧补换行让残片自成一行（读取跳过残片）
    await audit.record({ ...base, event: "submit-confirmed", previewId: "pv-1", previewDigest: "0".repeat(64), nativeKind: "task", nativeId: "task-1" });
    const raw = readFileSync(filePath, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(4);
    const after = await audit.readAll();
    expect(after.map((e) => e.event)).toEqual(["preview", "submit", "submit-confirmed"]);
  });

  it("超界记录（>maxRecordBytes）拒绝落盘", async () => {
    const filePath = tempAuditPath();
    const audit = createOperatorChannelAudit({ filePath, maxRecordBytes: 256 });
    await expect(
      audit.record({
        at: "2026-08-19T00:00:00.000Z",
        channel: "work",
        event: "preview",
        mode: "run",
        action: `task.publish${"x".repeat(512)}`,
        tenant: "t-1",
        space: "ts",
      }),
    ).rejects.toThrow(/bound|too large|exceeds/i);
  });

  it("未知字段拒绝（固定字段面）", async () => {
    const filePath = tempAuditPath();
    const audit = createOperatorChannelAudit({ filePath });
    await expect(
      audit.record({
        at: "2026-08-19T00:00:00.000Z",
        channel: "work",
        event: "preview",
        mode: "run",
        action: "task.publish",
        tenant: "t-1",
        space: "ts",
        // @ts-expect-error 固定字段面不允许夹带输入正文
        input: { title: "secret" },
      }),
    ).rejects.toThrow(/unknown/i);
  });
});
