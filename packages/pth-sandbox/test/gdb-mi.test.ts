import { describe, it, expect } from "vitest";
import { parseMiLine, stoppedFromRecord, stoppedFromRecord, framesFromResult, variablesFromResult, CDebugSession } from "@away_from/pth-sandbox";

/**
 * gdb MI 协议解析（纯函数——调试协议基本集）。
 */

describe("gdb MI 解析", () => {
  it("^done 结果记录（简单键值）", () => {
    const r = parseMiLine("^done");
    expect(r?.kind).toBe("result");
    expect(r?.cls).toBe("done");
  });

  it("^done 带值（字符串/数字）", () => {
    const r = parseMiLine('^done,value="42",thread-id="1"');
    expect(r?.results?.["value"]).toBe("42");
    expect(r?.results?.["thread-id"]).toBe("1");
  });

  it("^done 带元组（{}）", () => {
    const r = parseMiLine('^done,frame={func="main",line="5",file="main.c"}');
    const f = r?.results?.["frame"] as { [k: string]: string };
    expect(f["func"]).toBe("main");
    expect(f["line"]).toBe("5");
  });

  it("^done 带列表（[]）与嵌套", () => {
    const r = parseMiLine('^done,stack=[frame={level="0",func="main"},frame={level="1",func="foo"}]');
    const s = r?.results?.["stack"] as Array<{ frame: { [k: string]: string } }>;
    expect(s.length).toBe(2);
    expect(s[0]?.frame?.["func"]).toBe("main");
    expect(s[1]?.frame?.["func"]).toBe("foo");
  });

  it("*stopped 执行记录（breakpoint-hit + frame）", () => {
    const r = parseMiLine('*stopped,reason="breakpoint-hit",disp="keep",bkptno="1",frame={func="main",line="7",file="main.c"}');
    const s = stoppedFromRecord(r);
    expect(s?.reason).toBe("breakpoint-hit");
    expect(s?.breakpointId).toBe("1");
    expect(s?.frame?.name).toBe("main");
    expect(s?.frame?.line).toBe(7);
  });

  it("*stopped exited-normally（现代 gdb——2026-08-12 审计 BUG-3）", () => {
    const rec = parseMiLine('*stopped,reason="exited-normally"');
    expect(rec?.kind).toBe("exec");
    expect(rec?.cls).toBe("stopped");
    const stopped = stoppedFromRecord(rec);
    expect(stopped?.reason).toBe("exited");
  });

  it("*stopped exited（旧 gdb 格式）", () => {
    const s = stoppedFromRecord(parseMiLine('*stopped,reason="exited"'));
    expect(s?.reason).toBe("exited");
  });

  it("@ target 流（程序 stdout——剥离引号）", () => {
    const r = parseMiLine('@"hello from program\n"');
    expect(r?.kind).toBe("target");
    expect(r?.text).toBe("hello from program\n");
  });

  it("~ 控制台输出（剥离引号）", () => {
    const r = parseMiLine('~"Breakpoint 1 at 0x1000: file main.c, line 5.\\n"');
    expect(r?.kind).toBe("console");
    expect(r?.text).toContain("Breakpoint 1");
  });

  it("(gdb) 提示符", () => {
    const r = parseMiLine("(gdb)");
    expect(r?.kind).toBe("prompt");
  });

  it("framesFromResult：栈帧列表", () => {
    const r = parseMiLine('^done,stack=[frame={level="0",func="main",file="main.c",line="9"},frame={level="1",func="helper"}]');
    const frames = framesFromResult(r);
    expect(frames.length).toBe(2);
    expect(frames[0]).toMatchObject({ id: 0, name: "main", file: "main.c", line: 9 });
  });

  it("variablesFromResult：变量列表", () => {
    const r = parseMiLine('^done,variables=[variable={name="x",value="42",type="int"},variable={name="s",value="\\"hi\\"",type="char *"}]');
    const vars = variablesFromResult(r);
    expect(vars.length).toBe(2);
    expect(vars[0]).toMatchObject({ name: "x", value: "42", type: "int" });
  });

  it("非停止/非 done 记录 → 空提取", () => {
    expect(stoppedFromRecord(parseMiLine("^running"))).toBeNull();
    expect(framesFromResult(parseMiLine("^error,msg=\"No stack.\""))).toEqual([]);
  });

  it("空行/垃圾行 → null", () => {
    expect(parseMiLine("")).toBeNull();
    expect(parseMiLine("garbage")).toBeNull();
  });

  it("S1-3：token 前缀解析（N^done）——命令响应按 token 关联", () => {
    const r = parseMiLine('7^done,value="x"');
    expect(r?.token).toBe(7);
    expect(r?.kind).toBe("result");
    expect(r?.cls).toBe("done");
    expect(r?.results?.["value"]).toBe("x");
    // 无 token 的记录 token 为 undefined
    expect(parseMiLine("^done")?.token).toBeUndefined();
  });
});

describe("DebugSession 事件接口（监视组件预留——2026-08-09）", () => {
  it("CDebugSession 构造接受 onEvent 回调（接口契约）", async () => {
    const events: string[] = [];
    const session = new CDebugSession({
      workDir: "/tmp/dbg-x",
      cc: "gcc",
      gdbBin: "gdb",
      onEvent: (e) => events.push(e.type),
    } as any);
    expect(session.onEvent).toBeDefined();
    // 会话方法签名契约（不实际启动 gdb——本机无 gdb）
    expect(typeof session.attach).toBe("function");
    expect(typeof session.setBreakpoint).toBe("function");
    expect(typeof session.continueExec).toBe("function");
    expect(typeof session.step).toBe("function");
  });

  it("S1-3：会话 id 用 UUID——并发构造不碰撞", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const s = new CDebugSession({ workDir: "/tmp/dbg-id" } as any);
      expect(s.id).toMatch(/^c-debug-[0-9a-f-]{36}$/);
      ids.add(s.id);
    }
    expect(ids.size).toBe(20);
  });

  it("S1-3：token 化命令单飞——并发命令被拒绝", async () => {
    const s = new CDebugSession({ workDir: "/tmp/dbg-reentry", timeoutMs: 2_000 } as any);
    const writes: string[] = [];
    (s as any).child = { stdin: { write: (v: string) => { writes.push(v); } } };
    const p1 = (s as any).command("-stack-list-frames");
    expect(writes[0]).toMatch(/^1-stack-list-frames/);
    await expect((s as any).command("-stack-list-variables")).rejects.toThrow(/重入/);
    (s as any).flushPending();   // 清理首个 pending 与其超时计时器
    await p1;
  });

  it("S1-3：detach 清理 .debug/<id> 工作目录（无 gdb 环境也执行清理）", async () => {
    const { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = mkdtempSync(path.join(tmpdir(), "dbg-clean-"));
    try {
      const s = new CDebugSession({ workDir: root } as any);
      const dir = path.join(root, ".debug", s.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "main.c"), "int main(){return 0;}");
      await s.detach();   // 无 gdb → -gdb-exit 容错，仍清理目录
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
