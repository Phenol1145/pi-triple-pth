/**
 * ptc/capabilities/dev.ts —— TCE W1：dev.* 能力对象。
 *
 * 从 agent-tools-registry.ts 抽出，行为逐字节保留（输出/截断/错误文案）。
 * 通过工厂在任务启动时绑定 taskWorkspace / kernel / toolstore / debugApi。
 */

import type { WorkerKernel } from "@away_from/pth-kernel-interpreter";
import type { AgentToolResult } from "../../agent-tool-types.js";
import {
  applyOutputMode,
  ensureAsmKernel,
  isAsmSource,
  readArtifact,
  resolveArtifact,
  truncate,
} from "./helpers.js";

export interface DevCapabilityDeps {
  kernel: WorkerKernel;
  taskWorkspace?: string;
  toolstore?: import("@away_from/pth-kernel-interpreter").Toolstore;
}

export interface DevCapability {
  write(input: { path: string; code: string; mode?: string }): Promise<AgentToolResult>;
  edit(input: { path: string; oldText: string; newText: string; mode?: string }): Promise<AgentToolResult>;
  build(input: { path: string; cc?: string; mode?: string }): Promise<AgentToolResult>;
  run(input: { path: string; cc?: string; timeoutMs?: number; mode?: string }): Promise<AgentToolResult>;
  save(input: { name: string; path: string; mode?: string }): Promise<AgentToolResult>;
  list(input?: { mode?: string }): Promise<AgentToolResult>;
}

export function createDevCapability(deps: DevCapabilityDeps): DevCapability {
  const { kernel, taskWorkspace, toolstore } = deps;

  return {
    async write(input) {
      const abs = resolveArtifact(taskWorkspace, input.path);
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, input.code, "utf-8");
      return { ok: true, value: { path: input.path }, stdout: `已写入 ${input.path}（${input.code.length} 字符）` };
    },

    async edit(input) {
      const abs = resolveArtifact(taskWorkspace, input.path);
      const content = await readArtifact(taskWorkspace, input.path);
      const oldText = input.oldText, newText = input.newText;
      const hits = content.split(oldText).length - 1;
      if (hits === 0) return { ok: false, error: `dev.edit: oldText 未匹配（${input.path}）` };
      if (hits > 1) return { ok: false, error: `dev.edit: oldText 匹配 ${hits} 处——需唯一（提供更多上下文）` };
      const { writeFile } = await import("node:fs/promises");
      await writeFile(abs, content.replace(oldText, newText), "utf-8");
      return { ok: true, value: { path: input.path }, stdout: `已编辑 ${input.path}（1 处替换）` };
    },

    async build(input) {
      // asm 分发（2026-08-12 asm-kernel 接线）：.s/.S 走汇编核（as+ld——target 可选多平台）——C 路径不变
      if (isAsmSource(input.path)) {
        const reg = await ensureAsmKernel({ kernel, toolstore });
        if (!reg.ok) return { ok: false, error: reg.error ?? "asm 核不可用" };
        if (!kernel.execute) return { ok: false, error: "asm 核: worker kernel 无 execute 路由" };
        const asmCode = await readArtifact(taskWorkspace, input.path);
        const ar = await kernel.execute("asm", asmCode, { buildOnly: true, target: (input as { target?: string }).target } as never);
        if (!ar.ok) return { ok: false, error: ar.error?.message ?? "汇编/链接失败" };
        return { ok: true, value: ar.value, stdout: `汇编链接成功（${input.path}${(input as { target?: string }).target ? ` → ${(input as { target?: string }).target}` : ""}）` };
      }
      if (!kernel.c) return { ok: false, error: "dev.build: C 编译核不可用（sandbox 未配置）" };
      const code = await readArtifact(taskWorkspace, input.path);
      const r = await kernel.c.execute(code, { buildOnly: true } as never);
      if (!r.ok) return { ok: false, error: r.error?.message ?? "编译失败" };
      return { ok: true, value: r.value, stdout: `编译成功（${input.path}）` };
    },

    async run(input) {
      // asm 分发（2026-08-12 asm-kernel 接线）：.s/.S 走汇编核（host 直跑 / qemu-<arch>）——C 路径不变
      if (isAsmSource(input.path)) {
        const reg = await ensureAsmKernel({ kernel, toolstore });
        if (!reg.ok) return { ok: false, error: reg.error ?? "asm 核不可用" };
        if (!kernel.execute) return { ok: false, error: "asm 核: worker kernel 无 execute 路由" };
        const asmCode = await readArtifact(taskWorkspace, input.path);
        const ar = await kernel.execute("asm", asmCode, { target: (input as { target?: string }).target, timeoutMs: input.timeoutMs } as never);
        if (!ar.ok) return { ok: false, error: ar.error?.message ?? "运行失败" };
        const out = truncate(ar.stdout ?? "", 4000);
        return applyOutputMode({ ok: true, value: ar.value, stdout: out.text, stderr: (ar.stderr ?? "").slice(0, 2000), truncated: out.truncated }, input.mode);
      }
      if (!kernel.c) return { ok: false, error: "dev.run: C 编译核不可用（sandbox 未配置）" };
      const code = await readArtifact(taskWorkspace, input.path);
      const r = await kernel.c.execute(code, { timeoutMs: input.timeoutMs as number | undefined } as never);
      if (!r.ok) return { ok: false, error: r.error?.message ?? "运行失败" };
      const out = truncate(r.stdout ?? "", 4000);
      return applyOutputMode({ ok: true, value: r.value, stdout: out.text, stderr: (r.stderr ?? "").slice(0, 2000), truncated: out.truncated }, input.mode);
    },

    async save(input) {
      if (!toolstore) return { ok: false, error: "dev.save: toolstore 未配置" };
      const name = input.name;
      if (!/^[\w.-]+$/.test(name)) return { ok: false, error: `dev.save: 非法单元名 "${name}"（限 [a-zA-Z0-9_.-]）` };
      const code = await readArtifact(taskWorkspace, input.path);
      await toolstore.writeText(`compiled-units/${name}.c`, code);
      return { ok: true, value: { name }, stdout: `已保存编译单元 ${name}（${code.length} 字符——跨任务复用）` };
    },

    async list() {
      if (!toolstore) return { ok: false, error: "dev.list: toolstore 未配置" };
      const files = await toolstore.listSubdir("compiled-units");
      const units = files.filter((f) => f.endsWith(".c")).map((f) => f.slice(0, -2));
      return { ok: true, value: units, stdout: units.length ? units.join("\n") : "（无编译单元）" };
    },
  };
}
