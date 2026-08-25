import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ComponentStore, type ComponentManifest } from "../../src/pth/components/store.js";
import { SlotBindingStore, validateSlotId } from "../../src/pth/components/slot-binding.js";
import { AuditWriter } from "../../src/pth/observability/audit.js";

// ── ustar writer（测试用最小实现）────────────────────────────────

function padOctal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}

function checksum(header: Buffer): number {
  let sum = 256;
  for (let i = 0; i < 512; i++) {
    if (i >= 148 && i < 156) continue;
    sum += header[i]!;
  }
  return sum;
}

function tarHeader(name: string, size: number, typeflag = "0"): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, "utf-8");
  buf.write(padOctal(0o644, 8), 100, 8, "utf-8");
  buf.write(padOctal(0, 8), 108, 8, "utf-8");
  buf.write(padOctal(0, 8), 116, 8, "utf-8");
  buf.write(padOctal(size, 12), 124, 12, "utf-8");
  buf.write(padOctal(0, 12), 136, 12, "utf-8");
  buf.write("        ", 148, 8, "utf-8");
  buf.write(typeflag, 156, 1, "utf-8");
  buf.write("ustar\0", 257, 6, "utf-8");
  buf.write("00", 263, 2, "utf-8");
  buf.write(padOctal(checksum(buf), 7), 148, 8, "utf-8");
  return buf;
}

function makeTar(files: { name: string; content: Buffer | string }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const content = typeof f.content === "string" ? Buffer.from(f.content, "utf-8") : f.content;
    chunks.push(tarHeader(f.name, content.length));
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(512));
  chunks.push(Buffer.alloc(512));
  return Buffer.concat(chunks);
}

// ── mock Redis（含 audit stream 支持）────────────────────────────

export class MockRedis {
  store = new Map<string, string>();
  streams = new Map<string, { id: string; fields: Record<string, string> }[]>();

  incr(key: string): Promise<number> {
    const v = Number(this.store.get(key) ?? "0") + 1;
    this.store.set(key, String(v));
    return Promise.resolve(v);
  }
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, value);
    return Promise.resolve("OK");
  }
  del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    let count = 0;
    for (const k of keys) if (this.store.delete(k)) count++;
    return Promise.resolve(count);
  }
  sadd(key: string, ...members: string[]): Promise<number> {
    const arr: string[] = JSON.parse(this.store.get(key) ?? "[]");
    let added = 0;
    for (const m of members) if (!arr.includes(m)) { arr.push(m); added++; }
    this.store.set(key, JSON.stringify(arr));
    return Promise.resolve(added);
  }
  smembers(key: string): Promise<string[]> {
    return Promise.resolve(JSON.parse(this.store.get(key) ?? "[]"));
  }
  srem(key: string, ...members: string[]): Promise<number> {
    const arr: string[] = JSON.parse(this.store.get(key) ?? "[]");
    const kept = arr.filter((m) => !members.includes(m));
    this.store.set(key, JSON.stringify(kept));
    return Promise.resolve(arr.length - kept.length);
  }
  xadd(key: string, _id: string, ...fields: string[]): Promise<string> {
    const rec: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) rec[fields[i]!] = fields[i + 1]!;
    const arr = this.streams.get(key) ?? [];
    const id = `${arr.length + 1}-0`;
    arr.push({ id, fields: rec });
    this.streams.set(key, arr);
    return Promise.resolve(id);
  }
  xtrim(): Promise<number> { return Promise.resolve(0); }
}

// ── helpers ──────────────────────────────────────────────────────

function agentManifest(overrides: Partial<ComponentManifest> = {}): ComponentManifest {
  return { type: "agent-program", name: "echo", systemPrompt: "PROMPT.md", ...overrides };
}

function schedulerManifest(name = "daily"): ComponentManifest {
  return { type: "scheduler", name, payload: { schedule: "0 9 * * *" } };
}

function agentArchive(files: { name: string; content: string }[], manifest?: ComponentManifest): Buffer {
  const mf = manifest ?? agentManifest();
  return makeTar([{ name: "agent.json", content: JSON.stringify(mf) }, ...files]);
}

function schedulerArchive(name = "daily"): Buffer {
  return makeTar([{ name: "definition.json", content: JSON.stringify({ name }) }]);
}

/** 读取审计流中的 action 事件列表 */
function auditEvents(redis: MockRedis): Array<{ action: string; details: Record<string, unknown>; tenantId: string; actor: string }> {
  const entries = redis.streams.get("audit:log") ?? [];
  return entries.map((e) => JSON.parse(e.fields.data ?? "{}"));
}

describe("targetSlot 空位绑定（F/WP4 Task 18）", () => {
  let tmpDir: string;
  let redis: MockRedis;
  let store: ComponentStore;
  let slots: SlotBindingStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pth-slot-"));
    redis = new MockRedis();
    store = new ComponentStore(redis as any, tmpDir, new AuditWriter(redis as any));
    slots = new SlotBindingStore(redis as any);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("上传携带 targetSlot → 登记 slot:{slotId}:binding（含 type/name/version/tenantId/boundAt）", async () => {
    const r = await store.save("t1", agentManifest({ targetSlot: "slot-a" }), agentArchive([{ name: "PROMPT.md", content: "hi" }], agentManifest({ targetSlot: "slot-a" })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const raw = redis.store.get("slot:slot-a:binding");
    expect(raw).toBeTruthy();
    const binding = JSON.parse(raw!);
    expect(binding.slotId).toBe("slot-a");
    expect(binding.type).toBe("agent-program");
    expect(binding.name).toBe("echo");
    expect(binding.version).toBe(1);
    expect(binding.tenantId).toBe("t1");
    expect(typeof binding.boundAt).toBe("string");
    expect(new Date(binding.boundAt).getTime()).not.toBeNaN();
  });

  it("读取 API：SlotBindingStore.get 返回绑定记录", async () => {
    await store.save("t1", schedulerManifest("daily"), schedulerArchive("daily"));
    await store.save("t1", { ...schedulerManifest("daily"), targetSlot: "slot-a" }, schedulerArchive("daily"));

    const g = await slots.get("slot-a");
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.value.name).toBe("daily");
    expect(g.value.type).toBe("scheduler");
    expect(g.value.version).toBe(2); // daily v1 无 targetSlot，v2 绑定
  });

  it("同 slot 二次绑定 → 覆盖（latest wins，新构件胜出）", async () => {
    await store.save("t1", agentManifest({ targetSlot: "slot-a" }), agentArchive([{ name: "PROMPT.md", content: "v1" }], agentManifest({ targetSlot: "slot-a" })));
    const r2 = await store.save("t1", agentManifest({ name: "echo2", targetSlot: "slot-a" }), agentArchive([{ name: "PROMPT.md", content: "v2" }], agentManifest({ name: "echo2", targetSlot: "slot-a" })));
    expect(r2.ok).toBe(true);

    const g = await slots.get("slot-a");
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.value.name).toBe("echo2");
    expect(g.value.version).toBe(1);
    expect(new Date(g.value.boundAt).getTime()).not.toBeNaN(); // 二次绑定覆盖时 boundAt 刷新
  });

  it("无 targetSlot 上传 → 仅存储，不产生 slot:*:binding 键", async () => {
    const r = await store.save("t1", schedulerManifest(), schedulerArchive());
    expect(r.ok).toBe(true);

    // 无任何 slot 绑定键
    for (const k of redis.store.keys()) expect(k.startsWith("slot:")).toBe(false);
    // 但构件已存储
    const g = await store.getByType("t1", "scheduler", "daily");
    expect(g.ok).toBe(true);
  });

  it("审计事件：slot_binding 含 slotId/type/name/version/boundAt", async () => {
    await store.save("t1", agentManifest({ targetSlot: "slot-a" }), agentArchive([{ name: "PROMPT.md", content: "hi" }], agentManifest({ targetSlot: "slot-a" })));

    const events = auditEvents(redis);
    const bindingEvents = events.filter((e) => e.action === "slot_binding");
    expect(bindingEvents.length).toBe(1);
    const ev = bindingEvents[0]!;
    expect(ev.tenantId).toBe("t1");
    expect(ev.actor).toBe("tenant");
    expect(ev.details.slotId).toBe("slot-a");
    expect(ev.details.type).toBe("agent-program");
    expect(ev.details.name).toBe("echo");
    expect(ev.details.version).toBe(1);
    expect(typeof ev.details.boundAt).toBe("string");
  });

  it("无 targetSlot 上传不产生 slot_binding 审计", async () => {
    await store.save("t1", schedulerManifest(), schedulerArchive());
    expect(auditEvents(redis).filter((e) => e.action === "slot_binding")).toHaveLength(0);
  });

  it("malformed targetSlot（空串）→ 拒绝上传（O(1) 登记校验）", async () => {
    const r = await store.save("t1", agentManifest({ targetSlot: "" }), agentArchive([{ name: "PROMPT.md", content: "hi" }], agentManifest({ targetSlot: "" })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("targetSlot");
    // 不产生绑定与审计
    expect(redis.store.get("slot::binding")).toBeUndefined();
    expect(auditEvents(redis)).toHaveLength(0);
  });

  it("读取未知 slot → 错误", async () => {
    const g = await slots.get("nope");
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error).toContain("nope");
  });

  it("validateSlotId O(1) 校验：空/超长/控制字符拒绝，合法通过", () => {
    expect(validateSlotId("")).toBeTruthy();
    expect(validateSlotId(123 as any)).toBeTruthy();
    expect(validateSlotId("a".repeat(129))).toBeTruthy();
    expect(validateSlotId("a\tb")).toBeTruthy();
    expect(validateSlotId("slot-a")).toBeNull();
  });
});

describe("legalAuth 声明式登记（F/WP4 Task 19）", () => {
  let tmpDir: string;
  let redis: MockRedis;
  let store: ComponentStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pth-legal-"));
    redis = new MockRedis();
    store = new ComponentStore(redis as any, tmpDir, new AuditWriter(redis as any));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("legalAuth 原样落盘：Redis 全量 manifest + 磁盘归档身份文件均含原值（不拦截不校验）", async () => {
    const auth = "session:gov-42:trace:abc";
    const mf = agentManifest({ name: "legal-agent", legalAuth: auth });
    const r = await store.save("t1", mf, agentArchive([{ name: "PROMPT.md", content: "hi" }], mf));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Redis 全量 manifest 含 legalAuth
    const rawManifest = redis.store.get("component:t1:agent-program:legal-agent:1");
    expect(rawManifest).toBeTruthy();
    expect(JSON.parse(rawManifest!).legalAuth).toBe(auth);

    // 磁盘 agent.json 原样
    const onDisk = JSON.parse(fs.readFileSync(path.join(r.value.root, "agent.json"), "utf-8"));
    expect(onDisk.legalAuth).toBe(auth);
  });

  it("审计事件 component_upload 含 legalAuth 字段", async () => {
    const auth = "session:gov-42";
    const mf = schedulerManifest("legal-sched");
    await store.save("t1", { ...mf, legalAuth: auth }, schedulerArchive("legal-sched"));

    const events = auditEvents(redis);
    const upload = events.find((e) => e.action === "component_upload");
    expect(upload).toBeTruthy();
    expect(upload!.tenantId).toBe("t1");
    expect(upload!.details.legalAuth).toBe(auth);
    expect(upload!.details.type).toBe("scheduler");
    expect(upload!.details.name).toBe("legal-sched");
    expect(upload!.details.version).toBe(1);
  });

  it("legalAuth 仅登记不拦截：无 targetSlot 时不产生绑定键，仅 component_upload 审计", async () => {
    const auth = "session:gov-42";
    const mf = schedulerManifest("legal-only");
    await store.save("t1", { ...mf, legalAuth: auth }, schedulerArchive("legal-only"));

    for (const k of redis.store.keys()) expect(k.startsWith("slot:")).toBe(false);
    const events = auditEvents(redis);
    expect(events.filter((e) => e.action === "slot_binding")).toHaveLength(0);
    expect(events.filter((e) => e.action === "component_upload")).toHaveLength(1);
  });

  it("targetSlot + legalAuth 同时携带：绑定记录与 slot_binding 审计均含 legalAuth", async () => {
    const auth = "session:gov-42";
    const mf = agentManifest({ name: "both", targetSlot: "slot-gov", legalAuth: auth });
    await store.save("t1", mf, agentArchive([{ name: "PROMPT.md", content: "hi" }], mf));

    const binding = JSON.parse(redis.store.get("slot:slot-gov:binding")!);
    expect(binding.legalAuth).toBe(auth);

    const events = auditEvents(redis);
    const slotEv = events.find((e) => e.action === "slot_binding");
    expect(slotEv!.details.legalAuth).toBe(auth);
    const uploadEv = events.find((e) => e.action === "component_upload");
    expect(uploadEv!.details.legalAuth).toBe(auth);
    expect(uploadEv!.details.targetSlot).toBe("slot-gov");
  });
});
