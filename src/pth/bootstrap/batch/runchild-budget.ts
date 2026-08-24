/**
 * bootstrap/batch/runchild-budget.ts —— P2-9 装配段：穿透执行预算账本 + runChild 执行缝。
 *
 * N15 B2：穿透执行预算账本（key = req.caller.taskId，单 batch 进程生命周期；
 * 任务不跨 batch 进程迁移——与现有「穿透共享父任务工作区」假设一致）。
 * 预算配置与 PTH_AGENT_MAX_STEPS 同语义：batch 进程配置中心快照，不逐调用热读。
 *
 * 0.16.3 穿透执行面（2026-08-18 用户裁决：显式原语 tasks.penetrate / 深度限 1 /
 * 失败报错由父决策 / 本批只做执行面）。runChild = 嵌套子 agent 执行缝：
 * 建子 kernel（子角色能力面，无 taskControl/penetration——深度限 1）→ 嵌套
 * runAgentTask（共享父任务工作区）→ dispose。校验编排在 tasking/penetration-runner。
 * N14 P2：runChild 提取为独立闭包——穿透 runner 与 tool-reg agent 态执行缝共用同一实现
 * （toolRegRunChild 进 TaskLoop deps；agent 态工具的授权 = tool-reg 条目治理审批本身）。
 */

import { resolve as resolvePath, relative as relativePath, isAbsolute, sep } from "node:path";
import { pthConfig } from "@away_from/pth-config";
import { DEFAULT_TENANT_ID } from "@away_from/pth-memory";
import { knownRoleById, runAgentTask } from "@away_from/pth-kernel-execution";
import type { WorkerReplica } from "@away_from/pth-kernel-execution";
import { createLlmFn, loadKernelConfig } from "@away_from/pth-kernel-interpreter";
import type { Toolstore } from "@away_from/pth-kernel-interpreter";
import { createKernelManager, createWorkerKernelWithManager } from "../../impls/kernels/index.js";
import {
  childBudgetFor,
  recordPenetrationUse,
  type PenetrationBudgetConfig,
  type PenetrationLedger,
  type PenetrationRunChild,
} from "../../tasking/index.js";
import type { BatchDataWorld, BatchLogger } from "./context.js";

/** N15 B2：穿透预算状态（ledgers + 配置快照）。 */
export interface PenetrationBudgetState {
  ledgers: Map<string, PenetrationLedger>;
  cfg: PenetrationBudgetConfig;
}

export function createPenetrationBudgetState(): PenetrationBudgetState {
  return {
    ledgers: new Map<string, PenetrationLedger>(),
    cfg: {
      maxSteps: pthConfig().num("PTH_PENETRATION_MAX_STEPS"),
      taskBudgetSteps: pthConfig().num("PTH_PENETRATION_TASK_BUDGET_STEPS"),
      timeoutMs: pthConfig().num("PTH_PENETRATION_TIMEOUT_MS"),
    },
  };
}

/** runChild 的进程级共享依赖（每 batch 一份）。 */
export interface PenetrationRunChildSharedDeps {
  budget: PenetrationBudgetState;
  sandboxKernelUrl: string;
  sandboxKernelSecret: string;
  modelRouter: any;
  dataWorld: BatchDataWorld;
  toolstore: Toolstore;
  batchLogger: BatchLogger;
}

/** runChild 的 per-worker 依赖（createWorker 每次调用注入）。 */
export interface PenetrationRunChildWorkerDeps {
  /** N28 T2：feasibility replica（off 为 undefined——grantIdentity 回退 worker:<roleId>）。 */
  replica: WorkerReplica | undefined;
  /** 穿透 runChild 共享父任务工作区（父 kernel ts.currentCwd——穿透调用发生在父任务程序内）。 */
  parentKernelRef: { current?: { ts: unknown } };
}

export function createPenetrationRunChild(
  shared: PenetrationRunChildSharedDeps,
  worker: PenetrationRunChildWorkerDeps,
): PenetrationRunChild {
  const { budget, sandboxKernelUrl, sandboxKernelSecret, modelRouter, dataWorld, toolstore, batchLogger } = shared;
  const { replica, parentKernelRef } = worker;
  const penetrationLedgers = budget.ledgers;
  const penetrationBudgetCfg = budget.cfg;
  return async (req) => {
            const started = Date.now();
            // N15 B2：每次穿透调用前先过预算闸——累计耗尽立即失败（父可回退 tasks.delegate）
            const ledgerKey = req.caller?.taskId ?? "unknown-task";
            const ledger = penetrationLedgers.get(ledgerKey) ?? { calls: 0, steps: 0 };
            const budgetResult = childBudgetFor(ledger, penetrationBudgetCfg);
            if (!budgetResult.ok) {
              return {
                ok: false,
                steps: ledger.steps,
                error: `${budgetResult.error}（父任务 ${ledgerKey}）`,
                durationMs: 0,
              };
            }
            const budget = budgetResult.budget!;
            const childRole = knownRoleById(req.childRoleId);
            if (!childRole) {
              return { ok: false, steps: 0, error: `穿透目标角色未注册: ${req.childRoleId}`, durationMs: 0 };
            }
            const childManager = createKernelManager({
              pythonMode: pthConfig().str("PTH_PYTHON_MODE") as any,
              bashMode: pthConfig().str("PTH_BASH_MODE") as any,
              sandboxKernel: {
                url: sandboxKernelUrl,
                secret: sandboxKernelSecret,
                grantSecret: pthConfig().str("PTH_EXECUTION_GRANT_SECRET"),
                grantIdentity: {
                  principalId: replica ? `worker:${replica.ref.workerId}` : `worker:${childRole.id}`,
                  roleId: childRole.id,
                  capabilities: childRole.capabilities ?? [],
                },
              },
              kernelConfig: loadKernelConfig(process.env),
              onKernelStderr: (language, line) => batchLogger.child(language === "python" ? "pykernel" : "bashkernel")?.warn(line.trim()),
              onKernelMetric: (metric) => {
                try { process.send?.({ kind: "metric", metric: { ...metric, domain: "penetration" } }); } catch { /* IPC 不可用 */ }
              },
            });
            const childLlm = createLlmFn({
              modelRouter,
              onMetric: (m) => {
                try { process.send?.({ kind: "metric", metric: { ...m, kind: "llm", domain: "penetration" } }); } catch { /* IPC 不可用 */ }
              },
            });
            const childKernel = createWorkerKernelWithManager({
              llm: childLlm, dataWorld, manager: childManager, toolstore,
              roleFilter: childRole.capabilities,
              memoryScope: childRole.memoryScope ? { role: childRole.id, scope: childRole.memoryScope } : undefined,
              roleId: childRole.id,
              // 深度限 1：不传 taskControl/penetration——嵌套子 agent 纯执行，不再派发/穿透
              registerKernel: (language, interpreter) => childManager.registerKernel(language, interpreter as never),
              readSource: pthConfig().str("PTH_SOURCE_ROOT")
                ? (relPath) => import("@away_from/pth-kernel-interpreter").then((m) => m.createReadSource(pthConfig().str("PTH_SOURCE_ROOT"))(relPath))
                : undefined,
              taskWorkspaceResolve: (relPath) => {
                const cwd = (childKernel.ts as unknown as { currentCwd?: string | null }).currentCwd;
                if (!cwd || !cwd.includes("/tasks/")) throw new Error("fs.task: 任务工作区未就绪（非任务上下文）");
                if (typeof relPath !== "string" || relPath.trim() === "" || relPath.includes("\0")) {
                  throw new Error(`fs.task: 仅允许相对路径（拒绝: ${String(relPath).slice(0, 60)}）`);
                }
                const base = resolvePath(cwd);
                const abs = resolvePath(base, relPath);
                const rel = relativePath(base, abs);
                if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
                  throw new Error(`fs.task: 路径越出任务工作区（拒绝: ${relPath.slice(0, 60)}）`);
                }
                return abs;
              },
            });
            try {
              // 共享父任务工作区（父 kernel ts.currentCwd——穿透调用发生在父任务程序内）
              const parentCwd = (parentKernelRef.current?.ts as { currentCwd?: string | null } | undefined)?.currentCwd;
              const r = await runAgentTask({
                llm: childLlm, kernel: childKernel, caps: childKernel.capabilities,
                task: { title: req.title, text: req.text },
                taskWorkspace: parentCwd ?? undefined,
                toolstore,
                role: childRole,
                // N15 B2：单次穿透预算（步数取 min(单次上限, 剩余累计额度)；超时取预算超时）
                maxSteps: budget.maxSteps,
                timeoutMs: budget.timeoutMs,
                asp: pthConfig().str("PTH_ASP_MODE") === "on",
                onTrace: (e) => {
                  if (e.type === "finish") {
                    try {
                      process.send?.({
                        kind: "activity",
                        activity: {
                          kind: "task.penetrate", taskId: req.caller.taskId, role: req.caller.roleId,
                          ...(replica ? { workerId: replica.ref.workerId } : {}),
                          ok: e.ok, step: e.steps,
                          // N15 B2：软限命中标记（累计耗尽走预算闸失败路径，不进这里）
                          budgetUsed: e.steps,
                          budgetExceeded: e.steps >= budget.maxSteps,
                          detail: `穿透 ${req.caller.roleId}→${req.childRoleId}（${req.skillId}）${e.ok ? "完成" : `失败: ${(e.error ?? "").slice(0, 80)}`}`,
                          batchPid: process.pid, at: Date.now(),
                        },
                      });
                    } catch { /* IPC 不可用 */ }
                  }
                },
              });
              const durationMs = Date.now() - started;
              // N15 B2：无论成败都按实际 steps 结算（防重试放大）；单次命中 maxSteps 不额外扣满
              penetrationLedgers.set(ledgerKey, recordPenetrationUse(ledger, r.steps));
              const budgetExceeded = r.steps >= budget.maxSteps;
              // 调用级成败（r.ok 是 agent-loop 层；done.result 缺失时父任务仍收失败——
              // 边级 okCalls 与父任务最终语义一致，防 B1 成功率口径虚高）
              const childOk = r.ok && r.value !== undefined && r.value !== null;
              // N15 B2：边级计量聚合（B1 地基）——成功/失败都计；incrementAggregate 缺失时 skip 不报错
              try {
                await dataWorld.memory.incrementAggregate?.(
                  `penetration-edge:${req.caller.roleId}->${req.childRoleId}`,
                  "penetration-edge",
                  [req.caller.roleId, req.childRoleId, "penetration-edge"],
                  {
                    calls: 1,
                    okCalls: childOk ? 1 : 0,
                    sumSteps: r.steps,
                    sumDurationMs: durationMs,
                    sumBudgetExceeded: budgetExceeded ? 1 : 0,
                  },
                  { parent: req.caller.roleId, child: req.childRoleId, ts: Date.now() },
                  { tenantId: req.caller.tenantId ?? DEFAULT_TENANT_ID },
                );
              } catch {
                /* 计量聚合容错（降级：预算照常结算，聚合行缺失不阻断穿透） */
              }
              if (!r.ok) return { ok: false, steps: r.steps, error: r.error ?? "子 agent 执行失败", durationMs };
              if (r.value === undefined || r.value === null) {
                return { ok: false, steps: r.steps, error: r.warning ? `soft-terminated: ${r.warning}` : "子 agent 未产出结果（done 未带 result）", durationMs };
              }
              return { ok: true, value: r.value, summary: r.summary, steps: r.steps, durationMs };
            } finally {
              childKernel.dispose();
            }
  };
}
