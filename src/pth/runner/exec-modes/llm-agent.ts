/**
 * runner/exec-modes/llm-agent.ts —— PTH_EXEC_MODE=tool-call / asp 的 LLM agent 执行路径。
 */
import { pthConfig } from "@away_from/pth-config";
import { runAgentTask, taskToolUnion, canonicalExposureChars, type AgentTraceEvent } from "@away_from/pth-kernel-execution";
import { visibleRegistryTools } from "@away_from/pth-kernel-interpreter";
import type { TaskOutcome, TaskSuspension } from "@away_from/pth-contracts";
import type { KnowledgeContext } from "../knowledge-context.js";
import { contextPromptProjection, formatKnowledgeContextPromptRows } from "../knowledge-context.js";
import { createProfessionalTaskCapability } from "../professional-task-capability.js";
import { buildTaskCapabilityInject } from "./task-capability-inject.js";
import type { ExecModeContext } from "./types.js";

export async function runLlmAgentMode(ctx: ExecModeContext): Promise<TaskOutcome | TaskSuspension> {
  const { deps, lease, work, config, traceId, ref, aborted } = ctx;
  const { kernel, role, caps, llm } = deps;
  const traceEvents: AgentTraceEvent[] = [];
  const { CacheStore } = await import("@away_from/pth-kernel-execution");
  const cacheStore = new CacheStore();
  const cs = cacheStore;
  const feasibility = deps.cognitiveResponsibilityMode === "feasibility";
  const sessionRef = (kernel as unknown as { sessionRef?: { current: { currentSpace: string } | null } }).sessionRef;
  // K3：空间从 kernel sessionRef.currentSpace 取（显式传参）；取不到用 "meta"。
  const space = sessionRef?.current?.currentSpace ?? "meta";
  if (feasibility && (
    !deps.replica ||
    !deps.memoryDirectory ||
    !deps.cognitiveWorkingSetProvider ||
    !deps.authorizedReads ||
    !deps.verifiedReadScopeFactory ||
    !deps.knowledgeContextProvider
  )) {
    return {
      lease: ref, status: "rejected", retryable: false,
      error: { code: "cognitive-feasibility-deps-missing", message: "feasibility mode requires replica/memoryDirectory/provider/authorizedReads/verifiedReadScopeFactory/knowledgeContextProvider" },
      artifacts: [], traceId,
    };
  }

  // N28 T6：ToolReg 快照 hoist——provider 与 agent-loop 共用同一份冻结快照（不得二次加载）。
  const toolRegistry = deps.toolRegStore
    ? await (await import("@away_from/pth-kernel-interpreter")).loadToolRegSnapshot(deps.toolRegStore, { tenantId: work.scope.tenantId })
    : undefined;

  // N28 T4/T6：verified scope 每任务恰好 mint 一次。
  let authorization: import("../../execution/index.js").VerifiedTaskReadScope | undefined;
  if (deps.replica && deps.verifiedReadScopeFactory) {
    try {
      authorization = deps.verifiedReadScopeFactory.forTask({ lease, work, space, worker: deps.replica });
    } catch (e) {
      if (feasibility) {
        return {
          lease: ref, status: "rejected", retryable: false,
          error: { code: "cognitive-scope-rejected", message: (e as Error).message },
          artifacts: [], traceId,
        };
      }
      deps.logger?.(`[verified-scope] forTask failed: ${(e as Error).message}`);
    }
  }

  let knowledgeContext: KnowledgeContext | undefined;
  let contextTrace: KnowledgeContext["retrievalTrace"];
  if (deps.knowledgeContextProvider) {
    try {
      knowledgeContext = await deps.knowledgeContextProvider.build({
        tenantId: work.scope.tenantId,
        space,
        roleId: role.id,
        domains: work.domains ?? [],
        title: work.title,
        text: work.text,
        catalogVersion: work.domainBinding?.catalogVersion ?? "",
        ...(deps.replica ? { workerId: deps.replica.workerId } : {}),
        ...(authorization ? { authorization } : {}),
      });
      contextTrace = knowledgeContext.retrievalTrace;
      if (feasibility && knowledgeContext.retrievalStatus === "retrieval-failed") {
        return {
          lease: ref, status: "rejected", retryable: false,
          error: { code: "cognitive-context-retrieval-failed", message: "knowledge context retrieval failed" },
          artifacts: [], traceId,
        };
      }
      if (feasibility && knowledgeContext.retrievalStatus === "retrieval-incomplete") {
        return {
          lease: ref, status: "rejected", retryable: false,
          error: { code: "cognitive-context-retrieval-incomplete", message: "knowledge context retrieval incomplete" },
          artifacts: [], traceId,
        };
      }
    } catch (e) {
      if (feasibility) {
        return {
          lease: ref, status: "rejected", retryable: false,
          error: { code: "cognitive-context-failed", message: (e as Error).message },
          artifacts: [], traceId,
        };
      }
      // 组合设计 §4.5 裁决：知识降级不阻塞任务——provider 抛错 → warn + 原文执行（仅 off）。
      deps.logger?.(`[knowledge-context] build failed: ${(e as Error).message}（降级原文执行）`);
      knowledgeContext = undefined;
    }
  }

  if (feasibility && (!contextTrace || contextTrace.directorySnapshotId !== deps.memoryDirectory?.snapshotId)) {
    return {
      lease: ref,
      status: "rejected",
      retryable: false,
      error: { code: "cognitive-directory-trace-mismatch", message: "Knowledge Context is missing or bound to another MemoryDirectory snapshot" },
      artifacts: [],
      traceId,
    };
  }

  const cognitive = deps.replica && deps.cognitiveWorkingSetProvider && deps.authorizedReads && contextTrace
    ? await deps.cognitiveWorkingSetProvider.build({
        taskId: lease.taskId,
        worker: deps.replica,
        directorySnapshotId: contextTrace.directorySnapshotId,
        roleId: role.id,
        loadPolicyRef: (role as { loadPolicyRef?: string }).loadPolicyRef,
        tenantId: work.scope.tenantId,
        space,
        domains: work.domains ?? [],
        title: work.title,
        text: work.text,
        catalogVersion: work.domainBinding?.catalogVersion ?? "",
        baseCaps: caps!,
        staticToolNames: ["done", ...taskToolUnion(role.actionTools, { asp: config.aspMode }).map((tool) => tool.name)],
        registryToolNames: toolRegistry ? visibleRegistryTools(toolRegistry, role.id).map((tool) => tool.name.replace(/\./g, "_")) : [],
        authorizedReads: deps.authorizedReads.forTask({ lease, work, space, worker: deps.replica, authorization: authorization! }),
      })
    : undefined;
  const taskCaps = cognitive?.capabilities ?? caps!;

  if (cognitive && knowledgeContext) {
    const admitted = cognitive.ledger.admitMemory(
      (knowledgeContext.entries ?? []).map((entry) => ({ id: entry.entryId, chars: canonicalExposureChars(contextPromptProjection(entry)) })),
    );
    const allowed = new Set(admitted.accepted.map((entry) => entry.id));
    knowledgeContext = {
      ...knowledgeContext,
      entries: knowledgeContext.entries.filter((entry) => allowed.has(entry.entryId)),
      omitted: {
        count: knowledgeContext.omitted.count + admitted.omitted.length,
        reason: admitted.omitted.length > 0 ? "cognitive-budget" : knowledgeContext.omitted.reason,
      },
    };
  }

  // 生命周期 P0/P1：根目标与发布者澄清从 payload 盖章读取
  const workPayload = (work.payload ?? {}) as {
    delivery?: { goal?: unknown };
    pauseAnswer?: { answer?: unknown; answeredBy?: unknown; answeredAt?: unknown };
  };
  const goal = typeof workPayload.delivery?.goal === "string" && workPayload.delivery.goal.trim() !== ""
    ? workPayload.delivery.goal
    : undefined;
  const pauseAnswer = workPayload.pauseAnswer;
  const publisherClarification = pauseAnswer && typeof pauseAnswer.answer === "string" && pauseAnswer.answer.trim() !== ""
    ? `（${typeof pauseAnswer.answeredBy === "string" && pauseAnswer.answeredBy !== "" ? pauseAnswer.answeredBy : "发布者"}）: ${pauseAnswer.answer.trim()}`
    : undefined;

  let taskText = work.text;
  if (knowledgeContext) {
    const header = `\n\n【Knowledge Context（catalog ${knowledgeContext.catalogVersion}）】\n`;
    const body = knowledgeContext.entries.length > 0
      ? formatKnowledgeContextPromptRows(knowledgeContext.entries.map(contextPromptProjection))
      : "无相关 official 知识条目";
    taskText = `${work.text}${header}${body}`;
  }

  const capabilityInject: Record<string, unknown> = buildTaskCapabilityInject({
    kernel,
    taskWorkspace: deps.workspace.dir,
    toolstore: (kernel as unknown as { toolstore?: import("@away_from/pth-kernel-interpreter").Toolstore }).toolstore,
    roleCapabilities: role.capabilities,
    ...(deps.networkExecuteFactory
      ? { networkExecute: deps.networkExecuteFactory({ taskId: lease.taskId, tenantId: work.scope.tenantId, roleId: role.id }) }
      : deps.networkExecute ? { networkExecute: deps.networkExecute } : {}),
    base: {
      cache: {
        get: (k: string) => cs.get(k),
        keys: () => cs.keys(),
        load: (k: string, c: string) => cs.load(k, String(c), "ts-program"),
        cancel: (k: string) => cs.cancel(k),
        index: () => cs.index(),
        utilization: () => cs.utilization(),
      },
    },
  });
  if (knowledgeContext) {
    // AB-03：与角色既有 capability（如 adversarial 的 knowledge.review / memory-keeper 的
    // knowledge.promote）合并，只注入/刷新 context，不覆盖同键能力。
    const existingKnowledge = taskCaps["knowledge"];
    const knowledgeCap = typeof existingKnowledge === "object" && existingKnowledge !== null && !Array.isArray(existingKnowledge)
      ? existingKnowledge as Record<string, unknown>
      : {};
    capabilityInject["knowledge"] = { ...knowledgeCap, context: knowledgeContext };
  }

  // Task 4：professional capability 按 N28 合并模式注入（不动 memory/skills/state）。
  // 只注入专业角色 Worker Replica，且 grant 由服务端签发；LLM 只能拿到任务级 facade。
  if (deps.replica && deps.professionalRegistry && deps.professionalArtifacts && deps.professionalGrantService) {
    try {
      const professionalGrant = deps.professionalGrantService.issue({
        lease: { taskId: lease.taskId, leaseId: lease.leaseId, generation: lease.generation },
        scope: {
          tenantId: work.scope.tenantId,
          principalId: `worker:${deps.replica.workerId}`,
          roles: [role.id],
          traceId: work.scope.traceId,
          space,
        },
        workspace: lease.workspace,
        language: "ts",
        capabilities: ["professional.execute"],
        ttlMs: deps.professionalGrantTtlMs ?? pthConfig().num("PTH_PROFESSIONAL_GRANT_TTL_MS", 1_800_000),
      });
      capabilityInject["professional"] = createProfessionalTaskCapability({
        lease,
        work,
        worker: deps.replica,
        role,
        grant: professionalGrant,
        registry: deps.professionalRegistry,
        artifacts: deps.professionalArtifacts,
        space,
      });
    } catch (error) {
      return {
        lease: ref,
        status: "rejected",
        retryable: false,
        error: { code: "professional-grant-issue-failed", message: (error as Error).message },
        artifacts: [],
        traceId,
      };
    }
  }

  if (cognitive) {
    const snapshot = cognitive.ledger.snapshot();
    const event = {
      type: "cognitive-working-set" as const,
      phase: "start" as const,
      taskId: lease.taskId,
      directorySnapshotId: cognitive.policy.directorySnapshotId,
      workerId: deps.replica!.workerId,
      toolNames: snapshot.toolNames,
      memoryEntryIds: snapshot.memoryEntryIds,
      skillIndexIds: snapshot.skillIndexIds,
      activeSkillIds: snapshot.activeSkillIds,
      usage: snapshot.usage,
      omitted: snapshot.omitted,
      retrievalTraceIds: snapshot.retrievalTraces.map((trace) => trace.traceId),
    };
    traceEvents.push(event);
    deps.onTrace?.(event);
  }

  const agentInput: Parameters<typeof runAgentTask>[0] = {
    llm: llm!,
    kernel,
    caps: taskCaps,
    task: { title: work.title, text: taskText },
    taskId: lease.taskId,
    ...(goal ? { goal } : {}),
    ...(publisherClarification ? { publisherClarification } : {}),
    taskWorkspace: deps.workspace.dir,
    toolstore: (kernel as unknown as { toolstore?: import("@away_from/pth-kernel-interpreter").Toolstore }).toolstore,
    role,
    asp: config.aspMode,
    sessionRef,
    cache: cs,
    capabilityInject,
    toolRegistry,
    ...(cognitive ? { toolAllowlist: cognitive.policy.toolNames } : {}),
    toolRegExec: deps.toolRegRunChild
      ? { runChild: deps.toolRegRunChild, caller: { taskId: lease.taskId, roleId: role.id, tenantId: work.scope.tenantId, delivery: null } }
      : undefined,
    // W4：CommandGateway 从 worker agent 主路退役——tool-call 已投影为代码并由
    // 方法级静态审核门控；语言工具仍由 agent-loop 的 EXEC_TOOL_CAP 内联门控兜底。
    ...(deps.extraTools ? { extraTools: deps.extraTools } : {}),
    ...(deps.adapterRegistry ? { adapterRegistry: deps.adapterRegistry } : {}),
    ...(deps.executionDispatcher ? { executionDispatcher: deps.executionDispatcher } : {}),
    onStep: deps.onStep,
    logger: deps.logger,
    onTrace: (e) => {
      traceEvents.push(e);
      deps.onTrace?.(e);
    },
  };
  // W-c：实时上下文经惰性 getter 暴露（runAgentTaskCore 在首个 await 后才设置 __messages）。
  deps.onContextReady?.(() => (agentInput as { __messages?: unknown }).__messages);

  const r = await runAgentTask(agentInput);

  // 2026-08-25 W-d：上下文快照交给 task-loop 汇集（transcript-observer 随轨迹落盘）
  if (r.contextCapture && deps.contextSink) deps.contextSink.push(r.contextCapture);

  if (cognitive) {
    const snapshot = cognitive.ledger.snapshot();
    const event = {
      type: "cognitive-working-set" as const,
      phase: "finish" as const,
      taskId: lease.taskId,
      directorySnapshotId: cognitive.policy.directorySnapshotId,
      workerId: deps.replica!.workerId,
      toolNames: snapshot.toolNames,
      memoryEntryIds: snapshot.memoryEntryIds,
      skillIndexIds: snapshot.skillIndexIds,
      activeSkillIds: snapshot.activeSkillIds,
      usage: snapshot.usage,
      omitted: snapshot.omitted,
      retrievalTraceIds: snapshot.retrievalTraces.map((trace) => trace.traceId),
    };
    traceEvents.push(event);
    deps.onTrace?.(event);
  }

  if (aborted()) {
    return { lease: ref, status: "cancelled", retryable: true, error: { code: "cancelled", message: "cancelled during agent execution" }, artifacts: [], traceId };
  }
  if (!r.ok) {
    return { lease: ref, status: "rejected", retryable: false, error: { code: "agent-failed", message: r.error }, artifacts: [], traceId };
  }
  if (r.pause) {
    return {
      kind: "publisher-question",
      question: r.pause.question,
      ...(r.pause.context ? { context: r.pause.context } : {}),
    };
  }
  if (r.humanApproval) {
    return { kind: "human", requestId: r.humanApproval.requestId };
  }
  if (r.value === undefined || r.value === null) {
    if (r.warning) {
      return { lease: ref, status: "rejected", retryable: true, error: { code: "soft-terminated", message: r.warning }, artifacts: [], traceId };
    }
    return { lease: ref, status: "rejected", retryable: false, error: { code: "agent-no-output", message: "agent 完成但未产出结果（done 未带 result）" }, artifacts: [], traceId };
  }
  return {
    lease: ref,
    status: "completed",
    result: { value: r.value, summary: r.summary ?? "", steps: r.steps },
    artifacts: [],
    traceId,
    ...(cognitive
      ? {
          usage: {
            "cognitive.memoryEntries": cognitive.ledger.snapshot().usage.memoryEntries,
            "cognitive.memoryChars": cognitive.ledger.snapshot().usage.memoryChars,
            "cognitive.skillIndexEntries": cognitive.ledger.snapshot().usage.skillIndexEntries,
            "cognitive.activeSkills": cognitive.ledger.snapshot().usage.activeSkills,
            "cognitive.skillChars": cognitive.ledger.snapshot().usage.skillChars,
            "cognitive.tools": cognitive.ledger.snapshot().usage.tools,
          },
        }
      : {}),
  };
}
