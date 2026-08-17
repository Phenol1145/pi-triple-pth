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

import type { TsReplExtension, ExtContext } from "./types.js";
import { DEFAULT_TENANT_ID, withMemoryTenant } from "@away_from/pth-memory";
import { config, configNumber } from "./perf-params.js";
import { readStrategies } from "./perf.js";
import type { PerfStrategy } from "./perf.js";
import fs from "node:fs/promises";
import path from "node:path";
import { parseMcpBundle, importMcpTools } from "../../tasking/mcp-decompose.js";

export const manageExtension: TsReplExtension = {
  id: "manage",
  provide: (ctx: ExtContext) => {
    // F2（AB-01）：任务路径按 taskContext.tenantId；无任务上下文走系统 default tenant。
    const store = () => withMemoryTenant(ctx.dataWorld.memory, ctx.taskContext?.current?.tenantId ?? DEFAULT_TENANT_ID);
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
            await store().write({
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
              const id = opts?.id ?? `strategy-${Date.now().toString(36)}`;
              // 2026-08-15 审计修复：id 进入文件名——拒绝路径穿越/保留字符（../ 与 / 等）
              if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
                return { ok: false, error: `manage.resource.scheme.publish: id 非法 "${String(id).slice(0, 60)}"（字母数字开头，仅 [A-Za-z0-9._-]）` };
              }
              const strategy: PerfStrategy = {
                id,
                name: String(opts?.name ?? ""),
                params: opts?.params ?? {},
                actions: opts?.actions,
                condition: opts?.condition,
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

        // ── 修复批准 → debug-case-writer（P3.6——controller 裁决批准修复触发）──
        fix: {
          approve: async (opts: { bugReport: string; fixSummary?: string; parentTaskId?: string }) => {
            const bugReport = String(opts?.bugReport ?? "");
            if (!bugReport.trim()) return { ok: false, error: "manage.fix.approve: bugReport 必填（bug 报告/复现步骤/原任务文本）" };
            if (bugReport.length > 12_000) return { ok: false, error: "manage.fix.approve: bugReport 过长（≤12000 字符——请压缩到必要事实）" };
            const { publishDebugCaseTask } = await import("../execution/debug-case-dispatch.js");
            const t = await publishDebugCaseTask(ctx.dataWorld.tasks, {
              bugReport,
              fixSummary: typeof opts?.fixSummary === "string" ? opts.fixSummary : undefined,
              parentTaskId: typeof opts?.parentTaskId === "string" ? opts.parentTaskId : undefined,
              source: "controller-fix-approved",
            });
            return { ok: true, id: t.id, role: "debug-case-writer", status: "pending", note: "调试用例任务已派发（最小复现+回归+边界用例——自修正闭环验证环节）" };
          },
        },

        // ── 记忆归档/清理 → draft 提案（治理层流转——记忆是核心资产，删除类动作不自动执行）──
        memory: {
          archive: async (opts: { id: string; rationale?: string }) => {
            const id = String(opts?.id ?? "");
            if (!id) return { ok: false, error: "manage.memory.archive: id 必填" };
            const existing = await store().get(id).catch(() => null);
            if (!existing) return { ok: false, error: `manage.memory.archive: 条目 ${id} 不存在` };
            if (existing.kind === "role-doc" || existing.kind.startsWith("role-doc:") || existing.kind === "capability-index") {
              return { ok: false, error: "manage.memory.archive: 系统资产（prompt 层）不可归档——走监督通道" };
            }
            // 提案落库（不直接改状态——监督批准后执行）
            const pid = `ma-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            await store().write({
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
            await store().write({
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

        // ── 工具注册通道（N14 P3——tool-reg 治理流：提案 → 对抗性审核 → 批准 → 注册生效）──
        // PTH_TOOL_WRITE_POLICY=manual（缺省）：治理任务分配即人工闸门——直写 official；
        // staged：tool-proposal draft → controller:adversarial 审核 → 监督批准 → 执行。
        tool: {
          /** 注册面清单（快照版本 + 条目三要素/执行体/可见性） */
          list: async () => {
            const { loadToolRegSnapshot } = await import("../execution/tool-registry.js");
            const snap = await loadToolRegSnapshot(store() as never);
            return {
              version: snap.version,
              budget: configNumber("PTH_TOOL_FACE_BUDGET", 24),
              policy: config().get("PTH_TOOL_WRITE_POLICY") ?? "manual",
              tools: [...snap.entries.values()].map((s) => ({
                name: s.name, version: s.version, pack: s.visibility.pack,
                executor: s.executor.type, roles: s.visibility.roles,
                anchor: s.description.anchor,
              })),
            };
          },
          /** 工具注册（晋升管线入口——候选 tool-function 包装为 tool-reg spec 后在此裁决） */
          register: async (opts: { spec?: unknown; rationale?: string }) => {
            const { validateToolRegSpec, validateToolRegAction, buildToolRegEntry, proposeToolRegistration } = await import("@away_from/pth-memory");
            const checked = validateToolRegSpec(opts?.spec);
            if (!checked.ok) return { ok: false, error: `manage.tool.register: ${checked.error}` };
            const action = await validateToolRegAction(store() as never, "register", checked.spec);
            if (!action.ok) return { ok: false, error: `manage.tool.register: ${action.error}` };
            const spec = action.spec;
            // 预算守卫（§3.3 执行位——每个投放角色的投影面不得超 PTH_TOOL_FACE_BUDGET）
            const budget = configNumber("PTH_TOOL_FACE_BUDGET", 24);
            const { toolFaceBudgetCheck } = await import("../execution/tool-registry.js");
            const check = await toolFaceBudgetCheck(store() as never, spec, budget);
            if (!check.ok) {
              return { ok: false, error: `manage.tool.register: 工具面预算守卫（≤${budget}）拒绝——${check.over.map((o) => `${o.role} ${o.face}→${o.projected}`).join("，")}；先走合并/退役提案（命题 3 防线）` };
            }
            const policy = config().get("PTH_TOOL_WRITE_POLICY") ?? "manual";
            if (policy === "staged") {
              const r = await proposeToolRegistration(store() as never, { action: "register", name: spec.name, spec, rationale: opts?.rationale });
              // 事件驱动编排（skill-proposal-review 同构）：提案落库即发 → trigger 自动派审核任务
              if (r.ok && r.id) ctx.onActivity?.({ kind: "tool.proposal.created", detail: r.id, at: Date.now() });
              return { ...r, status: "draft", note: "staged 策略——提案已落 draft（对抗性审核 → 监督批准 → 注册生效）" };
            }
            const entry = buildToolRegEntry(spec, { status: "official" });
            await store().write({
              ...entry,
              meta: { ...entry.meta, registeredAt: Date.now(), registeredBy: "manage.tool.register", ...(opts?.rationale ? { rationale: String(opts.rationale) } : {}) },
            } as never, { force: true });
            return { ok: true, id: entry.id, status: "official", note: "manual 策略——已直接注册（审计留痕）" };
          },
          /** 工具修订（不可变语义——version 必须递增；promotedFrom/版本链留痕） */
          revise: async (opts: { spec?: unknown; rationale?: string }) => {
            const { validateToolRegSpec, validateToolRegAction, buildToolRegEntry, proposeToolRegistration } = await import("@away_from/pth-memory");
            const checked = validateToolRegSpec(opts?.spec);
            if (!checked.ok) return { ok: false, error: `manage.tool.revise: ${checked.error}` };
            const action = await validateToolRegAction(store() as never, "revise", checked.spec);
            if (!action.ok) return { ok: false, error: `manage.tool.revise: ${action.error}` };
            const spec = action.spec;
            const budget = configNumber("PTH_TOOL_FACE_BUDGET", 24);
            const { toolFaceBudgetCheck } = await import("../execution/tool-registry.js");
            const check = await toolFaceBudgetCheck(store() as never, spec, budget);
            if (!check.ok) {
              return { ok: false, error: `manage.tool.revise: 工具面预算守卫（≤${budget}）拒绝——${check.over.map((o) => `${o.role} ${o.face}→${o.projected}`).join("，")}` };
            }
            const policy = config().get("PTH_TOOL_WRITE_POLICY") ?? "manual";
            if (policy === "staged") {
              const r = await proposeToolRegistration(store() as never, { action: "revise", name: spec.name, spec, rationale: opts?.rationale });
              if (r.ok && r.id) ctx.onActivity?.({ kind: "tool.proposal.created", detail: r.id, at: Date.now() });
              return { ...r, status: "draft", note: "staged 策略——修订提案已落 draft（对抗性审核 → 监督批准 → 生效）" };
            }
            const entry = buildToolRegEntry(spec, { status: "official" });
            await store().write({
              ...entry,
              meta: { ...entry.meta, registeredAt: Date.now(), registeredBy: "manage.tool.revise", ...(opts?.rationale ? { rationale: String(opts.rationale) } : {}) },
            } as never, { force: true });
            return { ok: true, id: entry.id, version: spec.version, status: "official", note: "manual 策略——修订已生效（新版本链留痕）" };
          },
          /** MCP 拆解包批量导入（D1）——逐条落 draft tool-proposal，永不直写 official */
          importMcp: async (opts: { bundle?: unknown }) => {
            const parsed = parseMcpBundle(opts?.bundle);
            if (!parsed.ok) return { ok: false, errors: parsed.errors };
            const r = await importMcpTools(store() as never, parsed.bundle);
            for (const ok of r.imported) {
              ctx.onActivity?.({ kind: "tool.proposal.created", detail: ok.proposalId, at: Date.now() });
            }
            return { ok: r.failed.length === 0, imported: r.imported, failed: r.failed };
          },
        },
      },
    };
  },
  doc: `- manage: 管理 SDK（controller 面——capabilities 含 "manage" 的角色可用）。
  manage.params.get() 参数全表；manage.params.set({key, value}) 热调参（PTH_* 立即生效）
  manage.resource.config({domain, key, value, rationale?}) 重启级参数 → draft（v8/pg/node/kernel/storage）
  manage.resource.scheme.list() 方案清单；.publish({name, params}) 发布方案；.apply({id}) 应用方案（参数生效）
  manage.fix.approve({bugReport, fixSummary?, parentTaskId?}) 修复批准 → 派发 debug-case-writer（最小复现+回归+边界用例）
  manage.memory.archive({id, rationale?}) 记忆归档提案（draft——监督批准后执行）
  manage.worker.propose({suggestedRoleId, parent, specialization, rationale}) 分化提案（draft）
  manage.tool.list() 注册工具面清单（N14）；manage.tool.register({spec, rationale?}) 工具注册（预算守卫 + PTH_TOOL_WRITE_POLICY 治理流）；manage.tool.revise({spec, rationale?}) 工具修订（version 递增——不可变语义）
  manage.tool.importMcp({bundle}) 导入 MCP 拆解 bundle（mcp-tool-bundle-v1）→ 逐条 tool-proposal draft（复用 tool.proposal.created 自动审核）`,
};
