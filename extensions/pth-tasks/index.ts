/**
 * Pi-Triple pth-tasks — PTH 任务发布工具（任务工具 Task 4）
 *
 * 注册 /pthtask 命令族：在 pi 会话内发布 PTH kernel 任务、查询状态、
 * 控制 batch、查看运行状态全景（监控面板铺垫）。
 *
 * 配置：PTH_URL（默认 http://localhost:3000）+ PTH_TOKEN（必需）——
 * 与 ptl hub kernel 命令同一后端（gateway /api/v1/kernel/*）。
 *
 * 交互层定位（用户指示）：PTL 会话即交互层——skill 教 agent 怎么写任务，
 * extension 提供命令原语，PTH kernel 消费。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parsePthtaskArgs, renderHelp, renderTasks } from "./commands.js";

function pthUrl(): string {
  return (process.env.PTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

function requireToken(): string {
  const token = process.env.PTH_TOKEN;
  if (!token) {
    throw new Error("未配置 PTH_TOKEN 环境变量（与 ptl hub 同一 token）");
  }
  return token;
}

async function request(path: string, init: RequestInit): Promise<Response> {
  const url = `${pthUrl()}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${requireToken()}`,
  };
  if (init.body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`PTH ${path} → HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res;
}

export default async function registerPthTasks(api: ExtensionAPI): Promise<void> {
  api.registerCommand("pthtask", {
    description: "PTH 任务发布工具: publish <desc> | status [id] | ls [--limit n] | batch add|remove [n] | run",
    getArgumentCompletions: (prefix: string) => {
      const parts = prefix.trim().split(/\s+/);
      const sub = parts[0] ?? "";
      const subs = [
        { value: "publish", label: "publish <描述>", description: "发布 PTH 任务" },
        { value: "ls", label: "ls [--limit n]", description: "任务列表" },
        { value: "status", label: "status", description: "kernel 运行状态全景" },
        { value: "batch", label: "batch add|remove [n]", description: "控制 batch" },
      ];
      if (parts.length <= 1) {
        return subs.filter((s) => s.value.startsWith(sub));
      }
      if (sub === "batch") {
        return ["add", "remove"].filter((s) => s.startsWith(parts[1] ?? "")).map((value) => ({ value, label: `batch ${value} [n]`, description: "" }));
      }
      return [];
    },
    handler: async (args) => {
      const cmd = parsePthtaskArgs(args ?? "");

      if (cmd.kind === "help") return renderHelp();

      if (cmd.kind === "publish") {
        const res = await request("/api/v1/kernel/tasks", {
          method: "POST",
          body: JSON.stringify({
            title: cmd.desc.slice(0, 80),
            text: cmd.desc,
            createdBy: "ptl-session",
            tags: cmd.tags,
          }),
        });
        const task = (await res.json()) as Record<string, unknown>;
        return `✅ 任务已发布\n  id: ${task.id}\n  status: ${task.status}\n  查看: /pthtask ls`;
      }

      if (cmd.kind === "ls") {
        const res = await request(`/api/v1/kernel/tasks?limit=${cmd.limit}`, { method: "GET" });
        return renderTasks((await res.json()) as Array<Record<string, unknown>>);
      }

      if (cmd.kind === "batch") {
        if (cmd.action === "add") {
          const res = await request("/api/v1/kernel/batch/add", { method: "POST", body: JSON.stringify({ count: cmd.count }) });
          const body = (await res.json()) as { spawned: number };
          return `✅ 已启动 ${body.spawned} 个 batch`;
        }
        const res = await request("/api/v1/kernel/batch/remove", { method: "POST", body: JSON.stringify({ count: cmd.count }) });
        const body = (await res.json()) as { stopped: number };
        return `已停止 ${body.stopped} 个 batch`;
      }

      // status — 运行状态全景（监控面板铺垫）
      const res = await request("/api/v1/kernel/status", { method: "GET" });
      const s = (await res.json()) as {
        kernel: { connected: boolean };
        batches: Array<Record<string, unknown>>;
        tasks: Record<string, number>;
        watchdog: { crashLog: Array<Record<string, unknown>> };
      };
      const lines = [
        `kernel: ${s.kernel.connected ? "connected" : "disconnected"}`,
        `batches: ${s.batches.length} 个`,
        ...s.batches.map((b) => `  ${b.alive ? "●" : "○"} ${String(b.id ?? "").slice(0, 8)} pid=${b.pid} workers=${Array.isArray(b.workers) ? b.workers.length : 0} idle=${Math.round(Number(b.idleRatio ?? 1) * 100)}%`),
        `tasks: pending=${s.tasks.pending ?? 0} completed=${s.tasks.completed ?? 0} rejected=${s.tasks.rejected ?? 0} total=${s.tasks.total ?? 0}`,
        `watchdog crashes: ${s.watchdog.crashLog.length}`,
      ];
      return `PTH 运行状态:\n${lines.join("\n")}`;
    },
  });
}
