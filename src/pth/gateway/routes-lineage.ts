/**
 * routes-lineage —— 角色谱系 API（树状分化——监督层数据面）
 *
 *   GET  /api/v1/kernel/lineage            谱系树（结构 + 文本渲染——ptl hub lineage tree）
 *   POST /api/v1/kernel/lineage/approve    批准分化建议 → 注册新角色（树生长——batch 热上线）
 *   POST /api/v1/kernel/lineage/reject     拒绝分化建议（archived）
 *
 * 有监督自动化：refine 任务 3 产出 differentiation-proposal（draft）→ 本端点人工批准才执行分化。
 */

import type { FastifyInstance } from "fastify";
import type { KernelRuntime } from "../kernel/assembly.js";
import {
  buildRoleLineage, renderRoleLineage, allLineageRoles, registerWorkerRole,
  type WorkerRole,
} from "../kernel/execution/worker-cluster.js";
import { buildRoleDoc } from "../kernel/prompt-docs.js";

const KERNEL_UNAVAILABLE = { error: "kernel unavailable", reason: "DATABASE_URL 未配置或 pg 不可达" };

interface ProposalContent {
  taskId?: string;
  parent?: string;
  subtasks?: Array<{ type: string; description: string; capabilityNeeds?: string[] }>;
  suggestedRole?: { id: string; parent: string; specialization: string; rationale: string } | null;
  confidence?: string | null;
  rationale?: string | null;
  status?: string;
}

export function registerLineageRoutes(app: FastifyInstance, kernel: KernelRuntime | null): void {
  const unavailable = (reply: { status: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.status(503).send(KERNEL_UNAVAILABLE);

  // ── 谱系树（结构 + 文本渲染）──
  app.get("/api/v1/kernel/lineage", async (_req, reply) => {
    if (!kernel) return unavailable(reply);
    const roles = allLineageRoles();
    const tree = buildRoleLineage(roles);
    const toJson = (n: ReturnType<typeof buildRoleLineage>): unknown => ({
      id: n.role.id,
      generation: n.role.generation ?? null,
      thinking: n.role.thinking ?? null,
      acceptanceRole: n.role.acceptanceRole ?? null,
      differentiation: n.role.differentiation ?? null,
      children: n.children.map(toJson),
    });
    return {
      tree: toJson(tree),
      text: renderRoleLineage(tree),
      roles: roles.map((r) => ({
        id: r.id, parent: r.parent ?? null, generation: r.generation ?? null,
        thinking: r.thinking ?? null, acceptanceRole: r.acceptanceRole ?? null,
        description: r.description ?? null, differentiation: r.differentiation ?? null,
      })),
    };
  });

  // ── 批准分化建议 → 注册新角色（树生长）──
  // body: { proposalId, overrides?: { id?, labelPatterns?, prompt?, thinking?, capabilities?, acceptanceRole? } }
  app.post("/api/v1/kernel/lineage/approve", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const proposalId = typeof body.proposalId === "string" ? body.proposalId : "";
    if (!proposalId) return reply.status(400).send({ error: "proposalId required" });
    const overrides = (body.overrides ?? {}) as Record<string, unknown>;

    // 1. 读 proposal（draft 才可批准——幂等防重）
    const entries = await kernel.dataWorld.memory.retrieve({ kinds: ["differentiation-proposal"] });
    const proposal = entries.find((e) => e.id === proposalId);
    if (!proposal) return reply.status(404).send({ error: "proposal not found", proposalId });
    if (proposal.status !== "draft") {
      return reply.status(409).send({ error: "proposal already processed", proposalId, status: proposal.status });
    }
    let content: ProposalContent = {};
    try { content = JSON.parse(proposal.content) as ProposalContent; } catch { /* 容错 */ }
    const suggested = content.suggestedRole ?? null;
    const roleId = (typeof overrides.id === "string" && overrides.id) || suggested?.id || "";
    if (!roleId) return reply.status(400).send({ error: "proposal 缺 suggestedRole.id——overrides.id 显式指定", proposalId });
    if (allLineageRoles().some((r) => r.id === roleId)) {
      return reply.status(409).send({ error: `角色已存在: ${roleId}`, proposalId });
    }

    // 2. 构造新角色（parent 代数+1——labelPatterns 从 subtasks 派生——overrides 优先）
    const parentId = suggested?.parent || content.parent || "origin";
    const parentRole = allLineageRoles().find((r) => r.id === parentId);
    const generation = (parentRole?.generation ?? 0) + 1;
    const derivedPatterns = (content.subtasks ?? []).map((s) => s.type).filter(Boolean).slice(0, 4);
    const labelPatterns = Array.isArray(overrides.labelPatterns)
      ? (overrides.labelPatterns as unknown[]).map(String).filter(Boolean)
      : derivedPatterns.length > 0 ? derivedPatterns : [roleId];
    const prompt = typeof overrides.prompt === "string" && overrides.prompt
      ? overrides.prompt
      : `你是 ${roleId}——${suggested?.specialization ?? "专门"}角色（从 ${parentId} 分化——generation ${generation}）。分化理由：${suggested?.rationale ?? content.rationale ?? "任务分化诱导"}。专注子任务类型：${(content.subtasks ?? []).map((s) => `${s.type}（${s.description}）`).join("、") || "通用"}。按 PTC 模式用 ts 程序组合能力完成——done 提交实际产物。`;
    const newRole: WorkerRole = {
      id: roleId,
      labelPatterns,
      prompt,
      description: suggested?.specialization ?? `${roleId}（分化自 ${parentId}）`,
      thinking: overrides.thinking === "low" || overrides.thinking === "medium" || overrides.thinking === "high"
        ? overrides.thinking : (parentRole?.thinking ?? "medium"),
      capabilities: Array.isArray(overrides.capabilities)
        ? (overrides.capabilities as unknown[]).map(String).filter(Boolean)
        : parentRole?.capabilities,
      acceptanceRole: overrides.acceptanceRole === "read-only" || overrides.acceptanceRole === "writer"
        ? overrides.acceptanceRole : "writer",
      parent: parentId,
      generation,
      differentiation: suggested?.rationale ?? content.rationale ?? `任务 ${content.taskId ?? "?"} 分化诱导`,
    };

    // 3. 主进程注册（路由面——routeTaskRole 即刻可路由）
    try {
      registerWorkerRole(newRole);
    } catch (e) {
      return reply.status(400).send({ error: `角色注册失败: ${(e as Error).message}`, proposalId });
    }

    // 4. 广播 batch（role-register——batch 内注册+创建 worker——即刻接任务）
    const batchesSent = kernel.batchManager.registerRoleToBatches(newRole as unknown as Record<string, unknown>);

    // 5. role-doc 注入（谱系文档——新角色 worker 读自己文档）
    try {
      await kernel.dataWorld.memory.write({
        id: `role-doc:${newRole.id}`,
        kind: "role-doc",
        anchors: ["role-doc", newRole.id, "角色", "prompt"],
        content: buildRoleDoc(newRole),
        status: "official",
        meta: { source: "lineage-approve", role: newRole.id, proposalId },
      }, { force: true });
    } catch { /* 文档注入失败容忍——角色已注册 */ }

    // 6. proposal 状态流转（draft → official——approved）
    await kernel.dataWorld.memory.write({
      id: proposal.id,
      kind: proposal.kind,
      anchors: proposal.anchors,
      content: JSON.stringify({ ...content, status: "approved", approvedRole: newRole.id, approvedAt: Date.now() }, null, 2),
      status: "official",
      meta: { ...(proposal.meta ?? {}), approved: true, approvedRole: newRole.id },
    }, { force: true });

    return {
      ok: true,
      proposalId,
      role: { id: newRole.id, parent: newRole.parent, generation: newRole.generation, labelPatterns: newRole.labelPatterns },
      batchesSent,
      tree: renderRoleLineage(),
    };
  });

  // ── 拒绝分化建议（draft → archived）──
  app.post("/api/v1/kernel/lineage/reject", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const proposalId = typeof body.proposalId === "string" ? body.proposalId : "";
    if (!proposalId) return reply.status(400).send({ error: "proposalId required" });
    const entries = await kernel.dataWorld.memory.retrieve({ kinds: ["differentiation-proposal"] });
    const proposal = entries.find((e) => e.id === proposalId);
    if (!proposal) return reply.status(404).send({ error: "proposal not found", proposalId });
    if (proposal.status !== "draft") {
      return reply.status(409).send({ error: "proposal already processed", proposalId, status: proposal.status });
    }
    let content: ProposalContent = {};
    try { content = JSON.parse(proposal.content) as ProposalContent; } catch { /* 容错 */ }
    await kernel.dataWorld.memory.write({
      id: proposal.id,
      kind: proposal.kind,
      anchors: proposal.anchors,
      content: JSON.stringify({ ...content, status: "rejected", rejectedAt: Date.now(), reason: typeof body.reason === "string" ? body.reason : null }, null, 2),
      status: "archived",
      meta: { ...(proposal.meta ?? {}), rejected: true },
    }, { force: true });
    return { ok: true, proposalId, status: "archived" };
  });
}
