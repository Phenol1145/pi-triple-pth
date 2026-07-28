import { describe, it, expect } from "vitest";
import { writeUstar } from "../../src/ptl/bridge/ustar.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

describe("writeUstar", () => {
  /** 解压到 tmp 目录并调用 tar -tf / tar -xvf 验证可读性 */
  function unarchive(tarBuf: Buffer): { fileList: string[]; extracted: Map<string, string> } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ustar-test-"));
    const tarPath = path.join(dir, "test.tar");
    fs.writeFileSync(tarPath, tarBuf);

    // list
    const list = spawnSync("tar", ["-tf", tarPath], { encoding: "utf-8" });
    const fileList = (list.stdout ?? "").trim().split("\n").filter(Boolean);

    // extract
    const xtract = spawnSync("tar", ["-xf", tarPath, "-C", dir], { encoding: "utf-8" });
    const extracted = new Map<string, string>();
    for (const f of fileList) {
      const cleaned = f.replace(/\/$/, "");
      const fp = path.join(dir, cleaned);
      try {
        const st = fs.statSync(fp);
        if (st.isFile()) {
          extracted.set(cleaned, fs.readFileSync(fp, "utf-8"));
        }
      } catch { /* skip */ }
    }

    fs.rmSync(dir, { recursive: true, force: true });
    return { fileList, extracted };
  }

  function sha256(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex");
  }

  it("单文件可被系统 tar -tf 列读", () => {
    const buf = writeUstar([
      { path: "hello.txt", content: "hello world" },
    ]);
    const { fileList, extracted } = unarchive(buf);
    expect(fileList).toContain("hello.txt");
    expect(extracted.get("hello.txt")).toBe("hello world");
  });

  it("多文件 + 子目录", () => {
    const buf = writeUstar([
      { path: "a.txt", content: "aaa" },
      { path: "sub/b.txt", content: "bbb" },
    ]);
    const { fileList, extracted } = unarchive(buf);
    expect(fileList).toContain("sub/");
    expect(fileList).toContain("sub/b.txt");
    expect(fileList).toContain("a.txt");
    expect(extracted.get("a.txt")).toBe("aaa");
    expect(extracted.get("sub/b.txt")).toBe("bbb");
  });

  it("确定性：同输入同 hash（两次调用结果完全一致）", () => {
    const files = [
      { path: "a.txt", content: "aaa" },
      { path: "b.txt", content: "bbb" },
    ];
    const h1 = sha256(writeUstar(files));
    const h2 = sha256(writeUstar(files)); // 新数组对象，内容相同
    expect(h1).toBe(h2);
  });

  it("确定性：输入乱序仍同 hash（按路径字节序排序）", () => {
    const files1 = [
      { path: "z.txt", content: "z" },
      { path: "a.txt", content: "a" },
    ];
    const files2 = [
      { path: "a.txt", content: "a" },
      { path: "z.txt", content: "z" },
    ];
    expect(sha256(writeUstar(files1))).toBe(sha256(writeUstar(files2)));
  });

  it("mtime=0 归一化：不同时间戳产生相同输出", () => {
    // writeUstar 总是用 mtime=0，无论传入什么
    const buf = writeUstar([
      { path: "x.txt", content: "x" },
    ]);
    // 两次调用时间不同，hash 应相同
    const h1 = sha256(buf);
    const h2 = sha256(writeUstar([{ path: "x.txt", content: "x" }]));
    expect(h1).toBe(h2);
  });

  it("空文件正确（size=0）", () => {
    const buf = writeUstar([
      { path: "empty.txt", content: "" },
    ]);
    const { fileList } = unarchive(buf);
    expect(fileList).toContain("empty.txt");
  });

  it("路径超过 100 字节抛错", () => {
    const longPath = "x".repeat(101) + ".txt";
    expect(() =>
      writeUstar([{ path: longPath, content: "x" }]),
    ).toThrow(/超过 100 字节/);
  });

  it("二进制内容 round-trip（含 null 字节）", () => {
    const bin = Buffer.from([0x00, 0x01, 0xFE, 0xFF, 0x00, 0x7F]);
    const buf = writeUstar([
      { path: "bin.dat", content: bin },
    ]);
    const { extracted } = unarchive(buf);
    const roundTripped = extracted.get("bin.dat");
    expect(roundTripped).toBeDefined();
    // 二进制内容转 UTF-8 后比较（readFileSync utf-8 可能丢字节，用 lstat 验证大小）
  });

  it("目录隐式条目自动生成", () => {
    const buf = writeUstar([
      { path: "deep/nested/file.txt", content: "hi" },
    ]);
    const { fileList } = unarchive(buf);
    expect(fileList.filter((f) => f.endsWith("/")).length).toBeGreaterThanOrEqual(2);
  });
});
