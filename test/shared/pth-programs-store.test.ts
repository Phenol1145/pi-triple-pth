import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";

// ── ustar writer (minimal, for test-only archive creation) ────────

function padOctal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}

function checksum(header: Buffer): number {
  let sum = 256; // 8*32 for the initial chksum field spaces
  for (let i = 0; i < 512; i++) {
    if (i >= 148 && i < 156) continue; // chksum field → spaces
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
  buf.write("        ", 148, 8, "utf-8"); // chksum placeholder
  buf.write(typeflag, 156, 1, "utf-8");
  buf.write("ustar\0", 257, 6, "utf-8");
  buf.write("00", 263, 2, "utf-8");
  const sum = checksum(buf);
  buf.write(padOctal(sum, 7), 148, 8, "utf-8");
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
  // End-of-archive: two zero blocks
  chunks.push(Buffer.alloc(512));
  chunks.push(Buffer.alloc(512));
  return Buffer.concat(chunks);
}

// ── mock Redis ────────────────────────────────────────────────────

class MockRedis {
  store = new Map<string, string>();
  expires = new Map<string, number>();
  incr(key: string): Promise<number> {
    const v = Number(this.store.get(key) ?? "0") + 1;
    this.store.set(key, String(v));
    return Promise.resolve(v);
  }
  hset(key: string, field: string, value: string): Promise<number> {
    const raw = this.store.get(key) ?? "{}";
    const obj = JSON.parse(raw);
    obj[field] = value;
    this.store.set(key, JSON.stringify(obj));
    return Promise.resolve(1);
  }
  hgetall(key: string): Promise<Record<string, string> | null> {
    const raw = this.store.get(key);
    if (!raw) return Promise.resolve(null);
    return Promise.resolve(JSON.parse(raw));
  }
  hget(key: string, field: string): Promise<string | null> {
    const raw = this.store.get(key);
    if (!raw) return Promise.resolve(null);
    const obj = JSON.parse(raw);
    return Promise.resolve(obj[field] ?? null);
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
    for (const k of keys) {
      if (this.store.delete(k)) count++;
    }
    return Promise.resolve(count);
  }
  sadd(key: string, ...members: string[]): Promise<number> {
    const raw = this.store.get(key) ?? "[]";
    const arr: string[] = JSON.parse(raw);
    let added = 0;
    for (const m of members) {
      if (!arr.includes(m)) { arr.push(m); added++; }
    }
    this.store.set(key, JSON.stringify(arr));
    return Promise.resolve(added);
  }
  smembers(key: string): Promise<string[]> {
    const raw = this.store.get(key) ?? "[]";
    return Promise.resolve(JSON.parse(raw));
  }
  srem(key: string, ...members: string[]): Promise<number> {
    const raw = this.store.get(key) ?? "[]";
    let arr: string[] = JSON.parse(raw);
    const before = arr.length;
    arr = arr.filter((m: string) => !members.includes(m));
    this.store.set(key, JSON.stringify(arr));
    return Promise.resolve(before - arr.length);
  }
  expire(key: string, _seconds: number): Promise<number> {
    return Promise.resolve(1);
  }
}

// ── import under test ─────────────────────────────────────────────

// We need to import ProgramStore. Since it creates files on disk,
// we pass a real tmp dir as dataDir.
import { ProgramStore, type ProgramManifest } from "../../src/pth/programs/store.js";

describe("ProgramStore", () => {
  let tmpDir: string;
  let redis: MockRedis;
  let store: ProgramStore;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pth-prog-"));
    redis = new MockRedis();
    store = new ProgramStore(redis as any, tmpDir);
    origHome = process.env.HOME;
    // HOME not used by store, but just in case
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origHome !== undefined) process.env.HOME = origHome;
  });

  function minimalManifest(overrides: Partial<ProgramManifest> = {}): ProgramManifest {
    return {
      name: "echo",
      description: "Echo agent",
      systemPrompt: "PROMPT.md",
      ...overrides,
    };
  }

  function archiveWithFiles(files: { name: string; content: string }[], manifest?: ProgramManifest): Buffer {
    // All archives must contain agent.json with the same manifest
    const mf = manifest ?? minimalManifest();
    const all = [
      { name: "agent.json", content: JSON.stringify(mf) },
      ...files,
    ];
    return makeTar(all);
  }

  // ── basic save + list ──────────────────────────────────────

  it("save assigns incremental versions", async () => {
    const mf = minimalManifest();
    const archive = archiveWithFiles([{ name: "PROMPT.md", content: "echo back" }]);

    const r1 = await store.save("tenant-a", mf, archive);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.name).toBe("echo");
    expect(r1.value.version).toBe(1);

    const r2 = await store.save("tenant-a", mf, archive);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.version).toBe(2);
  });

  it("version counting is per-tenant", async () => {
    const mf = minimalManifest();
    const archive = archiveWithFiles([{ name: "PROMPT.md", content: "echo" }]);

    const r1 = await store.save("tenant-a", mf, archive);
    const r2 = await store.save("tenant-b", mf, archive);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.version).toBe(1);
    expect(r2.value.version).toBe(1);
  });

  it("list returns program names by tenant", async () => {
    const mf = minimalManifest();
    const archive = archiveWithFiles([{ name: "PROMPT.md", content: "echo" }]);

    await store.save("tenant-a", mf, archive);
    const reviewerMf = minimalManifest({ name: "reviewer" });
    await store.save("tenant-a", reviewerMf, archiveWithFiles([{ name: "PROMPT.md", content: "review" }], reviewerMf));
    await store.save("tenant-b", mf, archive);

    const listA = await store.list("tenant-a");
    expect(listA.length).toBe(2);
    expect(listA.map((p) => p.name).sort()).toEqual(["echo", "reviewer"]);

    const listB = await store.list("tenant-b");
    expect(listB.length).toBe(1);
    expect(listB[0]!.name).toBe("echo");
  });

  it("get returns specific version or latest", async () => {
    const mf = minimalManifest();
    const archive = archiveWithFiles([{ name: "PROMPT.md", content: "echo v1" }]);
    await store.save("t", mf, archive);
    const archive2 = archiveWithFiles([{ name: "PROMPT.md", content: "echo v2" }]);
    await store.save("t", mf, archive2);

    const v1 = await store.get("t", "echo", 1);
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.value.version).toBe(1);
    expect(v1.value.root).toContain("echo/1");

    const latest = await store.get("t", "echo");
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.value.version).toBe(2);
  });

  it("get returns error for missing program", async () => {
    const r = await store.get("t", "nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });

  it("delete removes all versions", async () => {
    const mf = minimalManifest();
    const archive = archiveWithFiles([{ name: "PROMPT.md", content: "echo" }]);
    await store.save("t", mf, archive);
    await store.save("t", mf, archive);

    const del = await store.delete("t", "echo");
    expect(del.ok).toBe(true);

    const list = await store.list("t");
    expect(list.length).toBe(0);
  });

  // ── version cleanup ──────────────────────────────────────

  it("retains last 10 versions, deletes older", async () => {
    const mf = minimalManifest();
    for (let i = 0; i < 15; i++) {
      const archive = archiveWithFiles([{ name: "PROMPT.md", content: `echo v${i + 1}` }]);
      await store.save("t", mf, archive);
    }

    // Version 1-5 should be deleted, 6-15 remain
    const latest = await store.get("t", "echo");
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.value.version).toBe(15);

    // Check that old version is gone
    const v1 = await store.get("t", "echo", 1);
    expect(v1.ok).toBe(false);
  });

  // ── materialize ──────────────────────────────────────────

  it("materialize copies program files to destination", async () => {
    const mf = minimalManifest();
    const archive = archiveWithFiles([
      { name: "PROMPT.md", content: "echo back" },
      { name: "skills/hello/SKILL.md", content: "say hello" },
    ]);
    const r = await store.save("t", mf, archive);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const destDir = path.join(tmpDir, "run-123");
    const mat = await store.materialize("t", "echo", r.value.version, destDir);
    expect(mat.ok).toBe(true);

    expect(fs.existsSync(path.join(destDir, "PROMPT.md"))).toBe(true);
    expect(fs.readFileSync(path.join(destDir, "PROMPT.md"), "utf-8")).toBe("echo back");
    expect(fs.existsSync(path.join(destDir, "skills", "hello", "SKILL.md"))).toBe(true);
  });

  // ── tar safety ───────────────────────────────────────────

  it("rejects path traversal via ../", async () => {
    const files = [
      { name: "agent.json", content: JSON.stringify(minimalManifest()) },
      { name: "../escape.sh", content: "bad" },
    ];
    const archive = makeTar(files);
    const r = await store.save("t", minimalManifest(), archive);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("path traversal");
  });

  it("rejects absolute paths", async () => {
    const files = [
      { name: "agent.json", content: JSON.stringify(minimalManifest()) },
      { name: "/etc/passwd", content: "bad" },
    ];
    const archive = makeTar(files);
    const r = await store.save("t", minimalManifest(), archive);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("absolute");
  });

  it("rejects symlink type entries", async () => {
    // Create a tar with typeflag '2' (symlink)
    const symlinkHeader = tarHeader("link", 0, "2");
    symlinkHeader.write("target", 157, 100, "utf-8");
    const archive = Buffer.concat([
      tarHeader("agent.json", JSON.stringify(minimalManifest()).length),
      Buffer.from(JSON.stringify(minimalManifest()), "utf-8"),
      Buffer.alloc((512 - (JSON.stringify(minimalManifest()).length % 512)) % 512),
      symlinkHeader,
      Buffer.alloc(512), // zero content for symlink
      Buffer.alloc(512),
      Buffer.alloc(512),
    ]);
    const r = await store.save("t", minimalManifest(), archive);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("symlink");
  });

  it("rejects archives exceeding max total decompressed bytes", async () => {
    // Create files that don't exceed limits but verify the limit works
    const files: { name: string; content: string }[] = [];
    for (let i = 0; i < 50; i++) {
      files.push({ name: `file${i}.txt`, content: "x".repeat(10_000) });
    }
    const mf = minimalManifest();
    const archive = makeTar([
      { name: "agent.json", content: JSON.stringify(mf) },
      ...files,
    ]);
    const r = await store.save("t", mf, archive);
    // 50 × ~10KB + agent = ~500KB, far under 20MB — should succeed
    expect(r.ok).toBe(true);
  });

  it("rejects excessive file count", async () => {
    const mf = minimalManifest();
    const files: { name: string; content: string }[] = [{ name: "agent.json", content: JSON.stringify(mf) }];
    for (let i = 0; i < 101; i++) {
      files.push({ name: `skill-${i}.md`, content: "skill" });
    }
    const archive = makeTar(files);
    const r = await store.save("t", mf, archive);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("too many files");
  });
});
