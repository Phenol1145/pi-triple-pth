/**
 * extensions/manage.ts —— manage 扩展（管理 SDK——2026-08-12 第二步：controller 面）。
 *
 * 定位：controller 角色的控制动作面（u 工具族）——按角色白名单授予（capabilities 含 "manage"）：
 *   manage.params            —— 热调参（PTH_*——perf.set 同源）
 *   manage.resource.config   —— 重启级参数 → draft（kind=resource-config——监督批准后应用）
 *   manage.resource.scheme   —— 优化方案管理（publish/apply/list——perf 同源放开给管理面）
 *   manage.memory.archive    —— 记忆归档/清理 → draft 提案（kind=memory-admin-proposal——治理层流转）
 *   manage.worker.propose    —— worker 分化提案（kind=differentiation-proposal——refiner 同源）
 *
 * 与 perf 扩展分工：perf 是"读侧分析"（worker 面裁剪后仅读）；manage 是"写侧控制"（controller 面）。
 * 安全边界：所有写动作经用途层策略（draft 强制/系统资产只读）；无任意 SQL/任意文件写。
 */

import type { TsReplExtension, ExtContext } from "./index.js";
import { config } from "./perf-params.js";
import { readStrategies } from "./perf.js";
import type { PerfStrategy } from "./perf.js";
import fs from "node:fs/promises";
import path from "node:path";

export const manageExtension: TsReplExtension = {
  id: "manage",
  provide: (ctx: ExtContext) => {
    const store = ctx.dataWorld.memory;
    return {
      manage: {
        // ── 热调参（perf.set 同源——PTH_* 白名单；运行时立即生效）──
        params: {
          get: () => config().snapshot(),
          set: (opts: { key: string; value: string | number }) => {
            const key = String(opts?.key ?? "");
            if (!key.startsWith("PTH_")) return { ok: false, error: "manage.params.set 仅允许 PTH_* 参数" };
            const value = String(opts?.value);
            config().set(key, value);
            return { ok: true, key, value };
          },
        },

        // ── 重启级参数 → draft（V8/NODE_OPTIONS/PG 实例级——监督批准后应用）──
        resource: {
          config: async (opts: { domain: "v8" | "pg" | "node" | "kernel" | "storage"; key: string; value: string; rationale?: string }) => {
            const domain = String(opts?.domain ?? "");
            const key = String(opts?.key ?? "");
            const value = String(opts?.value ?? "");
            if (!["v8", "pg", "node", "kernel", "storage"].includes(domain)) {
              return { ok: false, error: `manage.resource.config: 未知 domain "${domain}"（v8/pg/node/kernel/storage）` };
            }
            if (!/^[A-Za-z0-9_.\-]+$/.test(key)) return { ok: false, error: "manage.resource.config: key 非法" };
            if (value.length > 500) return { ok: false, error: "manage.resource.config: value 过长（≤500）" };
            // 治理：重启级参数落 draft——监督层批准后才应用（区别于热调参直接生效）
            const id = `rc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            await store.write({
              id,
              kind: "resource-config",
              anchors: [domain, key],
              content: { domain, key, value, rationale: String(opts?.rationale ?? "") },
              status: "draft",
              meta: { domain, key, ts: Date.now() },
            } as never);
            return { ok: true, id, domain, key, value, status: "draft", note: "重启级参数——已落 draft，监督批准后应用" };
          },
        },

        // ── 优化方案管理（publish/apply/list——默认方案保留；controller:resource 可替换/增删）──
        scheme: {
            list: () => readStrategies(ctx),
            publish: async (opts: { id?: string; name?: string; params?: Record<string, string>; actions?: PerfStrategy["actions"]; condition?: string }) => {
              const dir = ctx.strategiesDir ?? path.join(process.cwd(), "toolstore", "strategies");
              await fs.mkdir(dir, { recursive: true }).catch(() => {});
              const strategy: PerfStrategy = {
                id: opts.id ?? `strategy-${Date.now().toString(36)}`,
                name: String(opts.name ?? ""),
                params: opts.params ?? {},
                actions: opts.actions,
                condition: opts.condition,
                createdAt: Date.now(),
              };
              if (!strategy.name) return { ok: false, error: "manage.resource.scheme.publish: name 必填" };
              for (const k of Object.keys(strategy.params)) {
                if (!k.startsWith("PTH_")) return { ok: false, error: `manage.resource.scheme.publish: 参数 ${k} 非 PTH_*` };
              }
              await fs.writeFile(path.join(dir, `${strategy.id}.json`), JSON.stringify(strategy, null, 2), "utf8");
              return { ok: true, id: strategy.id, name: strategy.name, params: strategy.params, actions: strategy.actions?.length ?? 0 };
            },
            apply: async (opts: { id: string }) => {
              const list = await readStrategies(ctx);
              const s = list.find((x) => x.id === String(opts?.id ?? ""));
              if (!s) return { ok: false, error: `manage.resource.scheme.apply: 策略 ${String(opts?.id)} 不存在` };
              const applied: string[] = [];
              for (const [k, v] of Object.entries(s.params)) {
                config().set(k, v);
                applied.push(`${k}=${v}`);
              }
              return { ok: true, id: s.id, name: s.name, appliedParams: applied, actions: s.actions?.length ?? 0 };
            },
          },

        // ── 记忆归档/清理 → draft 提案（治理层流转——记忆是核心资产，删除类动作不自动执行）──
        memory: {
          archive: async (opts: { id: string; rationale?: string }) => {
            const id = String(opts?.id ?? "");
            if (!id) return { ok: false, error: "manage.memory.archive: id 必填" };
            const existing = await store.get(id).catch(() => null);
            if (!existing) return { ok: false, error: `manage.memory.archive: 条目 ${id} 不存在` };
            if (existing.kind === "role-doc" || existing.kind.startsWith("role-doc:") || existing.kind === "capability-index") {
              return { ok: false, error: "manage.memory.archive: 系统资产（prompt 层）不可归档——走监督通道" };
            }
            // 提案落库（不直接改状态——监督批准后执行）
            const pid = `ma-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            await store.write({
              id: pid,
              kind: "memory-admin-proposal",
              anchors: ["archive", id],
              content: { action: "archive", target: id, rationale: String(opts?.rationale ?? "") },
              status: "draft",
              meta: { action: "archive", target: id, ts: Date.now() },
            } as never);
            return { ok: true, id: pid, action: "archive", target: id, status: "draft", note: "归档提案已落 draft——监督批准后执行" };
          },
        },

        // ── worker 分化提案（refiner differentiation-proposal 同源入口）──
        worker: {
          propose: async (opts: { suggestedRoleId: string; parent: string; specialization: string; rationale: string; confidence?: "high" | "medium" | "low" }) => {
            const id = String(opts?.suggestedRoleId ?? "");
            const parent = String(opts?.parent ?? "");
            const specialization = String(opts?.specialization ?? "");
            const rationale = String(opts?.rationale ?? "");
            if (!/^[a-z0-9-]+$/.test(id) || !/^[a-z0-9-]+$/.test(parent)) {
              return { ok: false, error: "manage.worker.propose: id/parent 须为小写字母数字连字符" };
            }
            if (!specialization || !rationale) return { ok: false, error: "manage.worker.propose: specialization/rationale 必填" };
            const pid = `wp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            await store.write({
              id: pid,
              kind: "differentiation-proposal",
              anchors: [parent, id],
              content: {
                suggestedRole: { id, parent, specialization, rationale },
                confidence: opts?.confidence ?? "medium",
                source: "manage.worker.propose",
              },
              status: "draft",
              meta: { parent, suggested: id, ts: Date.now() },
            } as never);
            return { ok: true, id: pid, status: "draft", note: "分化提案已落 draft（监督层批准后注册角色）" };
          },
        },
      },
    };
  },
  doc: `- manage: 管理 SDK（controller 面——capabilities 含 "manage" 的角色可用）。
  manage.params.get() 参数全表；manage.params.set({key, value}) 热调参（PTH_* 立即生效）
  manage.resource.config({domain, key, value, rationale?}) 重启级参数 → draft（v8/pg/node/kernel/storage）
  manage.resource.scheme.list() 方案清单；.publish({name, params}) 发布方案；.apply({id}) 应用方案（参数生效）
  manage.memory.archive({id, rationale?}) 记忆归档提案（draft——监督批准后执行）
  manage.worker.propose({suggestedRoleId, parent, specialization, rationale}) 分化提案（draft）`,
};
