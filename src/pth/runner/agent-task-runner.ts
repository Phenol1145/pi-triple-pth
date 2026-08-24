/**
 * runner/agent-task-runner.ts — 纯任务执行器（模块化 v2 P1-4）。
 *
 * 只收 { lease, work }，产出 TaskOutcome；不调用 repository/audit/transcript/notify，
 * 也不做 workspace 分配/归档——这些副作用全部属于调度层。
 *
 * 执行路径（与 task-loop 原有语义一致）：
 *  - await kernel.reset() 完成后才开始执行（reset 为异步实现时也等待）；
 *  - agentMode + llm + caps → runAgentTask（主路径）；
 *  - agentMode=false / 无 caps + llm → translateTask + runPtcProgram（降级路径）；
 *  - 无 llm → rejected（任务池只面向自然语言）；
 *  - 取消信号：进入前 aborted 直接 cancelled；运行中 aborted 触发 kernel.abort()。
 */

import type { TaskLease, TaskOutcome, TaskRunner, TaskSuspension, TaskWorkItem } from "@away_from/pth-contracts";
import { TASK_AWAIT_SUSPENDED_CODE } from "@away_from/pth-contracts";
import type { WorkerKernel } from "@away_from/pth-kernel-interpreter";
import type { LlmFn } from "@away_from/pth-kernel-interpreter";
import type { WorkerRole } from "@away_from/pth-kernel-execution";
import { runAgentTask, runPtcAgentTask, type AgentTraceEvent } from "@away_from/pth-kernel-execution";
import { translateTask } from "@away_from/pth-kernel-execution";
import { runPtcProgram } from "@away_from/pth-kernel-interpreter";
import { defaultRunnerConfig, type RunnerConfig } from "./runner-config.js";
import type { TaskWorkspace } from "./task-workspace.js";
import type { KnowledgeContext, KnowledgeContextProvider } from "./knowledge-context.js";
import { contextPromptProjection, formatKnowledgeContextPromptRows } from "./knowledge-context.js";
import type { WorkerReplicaRef } from "@away_from/pth-contracts";
import type { MemoryDirectorySnapshot, VerifiedTaskReadScopeFactory } from "../execution/index.js";
import type { CognitiveWorkingSetProvider } from "./cognitive-working-set.js";
import type { AuthorizedTaskReadFactory } from "./authorized-task-reads.js";
import type { ExecutionGrantService, ProfessionalRuntimeRegistry } from "../execution/index.js";

import { createProfessionalTaskCapability, type ProfessionalArtifactPort } from "./professional-task-capability.js";
import { canonicalExposureChars } from "@away_from/pth-kernel-execution";
import { taskToolUnion, normalizeToolName } from "@away_from/pth-kernel-execution";
import { visibleRegistryTools } from "@away_from/pth-kernel-interpreter";

export interface AgentTaskRunnerDeps {
  kernel: WorkerKernel;
  role: WorkerRole;
  workspace: TaskWorkspace;
  /** 无 llm → 任务 rejected（与 task-loop 纯化语义一致） */
  llm?: LlmFn;
  /** agent 循环 capability 白名单（缺省空——agent 路径不可用，走降级通道） */
  caps?: Record<string, unknown>;
  config?: Partial<RunnerConfig>;
  /** 调用方持有的轨迹收集（runner 只写事件，不持久化） */
  onTrace?: (event: AgentTraceEvent) => void;
  onStep?: (step: { n: number; tool: string; durationMs: number; ok: boolean; args?: string }) => void;
  logger?: (msg: string) => void;
  /** N14 P2：tool-reg 注册表读取口（任务开始冻结快照——T3 防线）；缺省 = 注册面关闭 */
  toolRegStore?: import("@away_from/pth-kernel-interpreter").ToolRegStoreLike;
  /** N14 P2：agent 态注册工具执行缝（穿透 runChild 同一闭包——深度限 1 由实现保证） */
  toolRegRunChild?: import("@away_from/pth-kernel-interpreter").ToolRegRunChild;
  /** K3：任务知识上下文 provider（claim 后一次性快照；抛错 → logger warn + 原文执行，降级不阻塞） */
  knowledgeContextProvider?: KnowledgeContextProvider;
  /** N28 T4：本任务副本身份（feasibility 模式注入）。 */
  replica?: WorkerReplicaRef;
  /** N28 T4：每任务 mint 一次 verified scope 的 authority（缺失=legacy 路径）。 */
  verifiedReadScopeFactory?: VerifiedTaskReadScopeFactory;
  /** N28 T6：冻结 MemoryDirectory（feasibility 模式必填）。 */
  memoryDirectory?: MemoryDirectorySnapshot;
  /** N28 T6：working-set provider（feasibility 模式必填）。 */
  cognitiveWorkingSetProvider?: CognitiveWorkingSetProvider;
  /** N28 T6：认知责任模式（off=legacy 默认；feasibility=切片）。 */
  cognitiveResponsibilityMode?: "off" | "feasibility";
  /** N28 T6：grant-bound 任务读取工厂（feasibility 模式必填）。 */
  authorizedReads?: AuthorizedTaskReadFactory;
  /** Task 4：professional runtime registry（注入后任务内可用 professional.* capability）。 */
  professionalRegistry?: ProfessionalRuntimeRegistry;
  /** Task 4：artifact 端口（租户隔离输入读取/输出落盘）。 */
  professionalArtifacts?: ProfessionalArtifactPort;
  /** Task 4：签发 professional.execute grant 的服务（服务端签名/过期/replay）。 */
  professionalGrantService?: ExecutionGrantService;
  /** Task 4：professional grant TTL（缺省 120s）。 */
  professionalGrantTtlMs?: number;
  /** TCE P3：Command 层注入（语言工具先过 CommandGateway 授权；缺省 = legacy 直执行）。 */
  commandGateway?: import("@away_from/pth-kernel-execution").CommandGateway;
  /** TCE P5：Tool 层生成器产物（per-tool 工具面）。 */
  extraTools?: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>;
}

function leaseRef(lease: TaskLease): TaskOutcome["lease"] {
  return { taskId: lease.taskId, leaseId: lease.leaseId, generation: lease.generation };
}

export class AgentTaskRunner implements TaskRunner {
  constructor(private deps: AgentTaskRunnerDeps) {}

  async run(input: { lease: TaskLease; work: TaskWorkItem; signal?: AbortSignal }): Promise<TaskOutcome | TaskSuspension> {
    const { lease, work, signal } = input;
    const config = { ...defaultRunnerConfig(), ...this.deps.config };
    const traceId = work.scope.traceId;

    if (signal?.aborted) {
      return { lease: leaseRef(lease), status: "cancelled", retryable: true, error: { code: "cancelled", message: "cancelled before execution" }, artifacts: [], traceId };
    }

    // 任务级状态隔离：reset 异步实现也等待完成（审计 P1-2）
    await this.deps.kernel.reset();

    // 运行中取消：触发程序级制动（kernel.abort 终止 in-flight），结果以 cancelled 收口
    let aborted = signal?.aborted ?? false;
    const onAbort = () => {
      aborted = true;
      void this.deps.kernel.abort?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const outcome = await this.executeInner(lease, work, config, traceId, () => aborted);
      if (!("status" in outcome)) return outcome;
      if (aborted && outcome.status !== "cancelled") {
        return { lease: leaseRef(lease), status: "cancelled", retryable: true, error: { code: "cancelled", message: "cancelled during execution" }, artifacts: [], traceId };
      }
      return outcome;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async executeInner(
    lease: TaskLease,
    work: TaskWorkItem,
    config: RunnerConfig,
    traceId: string,
    aborted: () => boolean,
  ): Promise<TaskOutcome | TaskSuspension> {
    const { kernel, role, llm, caps } = this.deps;
    const ref = leaseRef(lease);

    // Wave 5：ptc 迭代模式。
    if (config.execMode === "ptc") {
      if (!llm) {
        return {
          lease: ref,
          status: "rejected",
          retryable: false,
          error: { code: "no-llm", message: "PTH_EXEC_MODE=ptc 需要 llm" },
          artifacts: [],
          traceId,
        };
      }
      const traceEvents: AgentTraceEvent[] = [];
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
      const r = await runPtcAgentTask({
        llm,
        kernel,
        task: { title: work.title, text: work.text },
        ...(goal ? { goal } : {}),
        ...(publisherClarification ? { publisherClarification } : {}),
        taskWorkspace: this.deps.workspace.dir,
        capabilityInject: this.deps.caps,
        logger: this.deps.logger,
        onTrace: (e) => {
          traceEvents.push(e);
          this.deps.onTrace?.(e);
        },
      });
      if (aborted()) {
        return { lease: ref, status: "cancelled", retryable: true, error: { code: "cancelled", message: "cancelled during ptc execution" }, artifacts: [], traceId };
      }
      if (r.ok && r.code === TASK_AWAIT_SUSPENDED_CODE) {
        return {
          lease: ref,
          status: "rejected",
          retryable: true,
          error: { code: TASK_AWAIT_SUSPENDED_CODE, message: r.warning ?? "task-await-suspended" },
          artifacts: [],
          traceId,
        };
      }
      if (!r.ok) {
        return { lease: ref, status: "rejected", retryable: false, error: { code: "ptc-failed", message: r.error }, artifacts: [], traceId };
      }
      if (r.value === undefined || r.value === null) {
        if (r.warning) {
          return { lease: ref, status: "rejected", retryable: true, error: { code: "soft-terminated", message: r.warning }, artifacts: [], traceId };
        }
        return { lease: ref, status: "rejected", retryable: false, error: { code: "ptc-no-output", message: "PTC 完成但未产出结果" }, artifacts: [], traceId };
      }
      return {
        lease: ref,
        status: "completed",
        result: { value: r.value, summary: r.summary ?? "", steps: r.steps },
        artifacts: [],
        traceId,
      };
    }

    // 显式 tool-call/asp 缺少必需能力 → fail-closed；legacy/default 走既有降级/无 llm 路径。
    if ((config.execMode === "tool-call" || config.execMode === "asp") && (!llm || !caps) && config.execModeExplicit) {
      return {
        lease: ref,
        status: "rejected",
        retryable: false,
        error: {
          code: "exec-mode-capability-missing",
          message: `PTH_EXEC_MODE=${config.execMode} 需要 llm+agentCaps（llm=${Boolean(llm)} caps=${Boolean(caps)}）——显式模式 fail-closed`,
        },
        artifacts: [],
        traceId,
      };
    }

    if ((config.execMode === "tool-call" || config.execMode === "asp") && llm && caps) {
      const traceEvents: AgentTraceEvent[] = [];
      const { CacheStore } = await import("@away_from/pth-kernel-execution");
      const cacheStore = new CacheStore();
      const cs = cacheStore;
      const feasibility = this.deps.cognitiveResponsibilityMode === "feasibility";
      const sessionRef = (kernel as unknown as { sessionRef?: { current: { currentSpace: string } | null } }).sessionRef;
      // K3：空间从 kernel sessionRef.currentSpace 取（显式传参）；取不到用 "meta"。
      const space = sessionRef?.current?.currentSpace ?? "meta";
      if (feasibility && (
        !this.deps.replica ||
        !this.deps.memoryDirectory ||
        !this.deps.cognitiveWorkingSetProvider ||
        !this.deps.authorizedReads ||
        !this.deps.verifiedReadScopeFactory ||
        !this.deps.knowledgeContextProvider
      )) {
        return {
          lease: ref, status: "rejected", retryable: false,
          error: { code: "cognitive-feasibility-deps-missing", message: "feasibility mode requires replica/memoryDirectory/provider/authorizedReads/verifiedReadScopeFactory/knowledgeContextProvider" },
          artifacts: [], traceId,
        };
      }

      // N28 T6：ToolReg 快照 hoist——provider 与 agent-loop 共用同一份冻结快照（不得二次加载）。
      const toolRegistry = this.deps.toolRegStore
        ? await (await import("@away_from/pth-kernel-interpreter")).loadToolRegSnapshot(this.deps.toolRegStore, { tenantId: work.scope.tenantId })
        : undefined;

      // N28 T4/T6：verified scope 每任务恰好 mint 一次。
      let authorization: import("../execution/index.js").VerifiedTaskReadScope | undefined;
      if (this.deps.replica && this.deps.verifiedReadScopeFactory) {
        try {
          authorization = this.deps.verifiedReadScopeFactory.forTask({ lease, work, space, worker: this.deps.replica });
        } catch (e) {
          if (feasibility) {
            return {
              lease: ref, status: "rejected", retryable: false,
              error: { code: "cognitive-scope-rejected", message: (e as Error).message },
              artifacts: [], traceId,
            };
          }
          this.deps.logger?.(`[verified-scope] forTask failed: ${(e as Error).message}`);
        }
      }

      let knowledgeContext: KnowledgeContext | undefined;
      let contextTrace: KnowledgeContext["retrievalTrace"];
      if (this.deps.knowledgeContextProvider) {
        try {
          knowledgeContext = await this.deps.knowledgeContextProvider.build({
            tenantId: work.scope.tenantId,
            space,
            roleId: role.id,
            domains: work.domains ?? [],
            title: work.title,
            text: work.text,
            catalogVersion: work.domainBinding?.catalogVersion ?? "",
            ...(this.deps.replica ? { workerId: this.deps.replica.workerId } : {}),
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
          this.deps.logger?.(`[knowledge-context] build failed: ${(e as Error).message}（降级原文执行）`);
          knowledgeContext = undefined;
        }
      }

      if (feasibility && (!contextTrace || contextTrace.directorySnapshotId !== this.deps.memoryDirectory?.snapshotId)) {
        return {
          lease: ref,
          status: "rejected",
          retryable: false,
          error: { code: "cognitive-directory-trace-mismatch", message: "Knowledge Context is missing or bound to another MemoryDirectory snapshot" },
          artifacts: [],
          traceId,
        };
      }

      const cognitive = this.deps.replica && this.deps.cognitiveWorkingSetProvider && this.deps.authorizedReads && contextTrace
        ? await this.deps.cognitiveWorkingSetProvider.build({
            taskId: lease.taskId,
            worker: this.deps.replica,
            directorySnapshotId: contextTrace.directorySnapshotId,
            roleId: role.id,
            loadPolicyRef: (role as { loadPolicyRef?: string }).loadPolicyRef,
            tenantId: work.scope.tenantId,
            space,
            domains: work.domains ?? [],
            title: work.title,
            text: work.text,
            catalogVersion: work.domainBinding?.catalogVersion ?? "",
            baseCaps: caps,
            staticToolNames: ["done", ...taskToolUnion(role.actionTools, { asp: config.aspMode }).map((tool) => tool.name)],
            registryToolNames: toolRegistry ? visibleRegistryTools(toolRegistry, role.id).map((tool) => tool.name.replace(/\./g, "_")) : [],
            authorizedReads: this.deps.authorizedReads.forTask({ lease, work, space, worker: this.deps.replica, authorization: authorization! }),
          })
        : undefined;
      const taskCaps = cognitive?.capabilities ?? caps;
      const completedContextTrace = cognitive && contextTrace
        ? cognitive.ledger.recordRetrievalTrace(contextTrace)
        : undefined;

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

      const capabilityInject: Record<string, unknown> = {
        cache: {
          get: (k: string) => cs.get(k),
          keys: () => cs.keys(),
          load: (k: string, c: string) => cs.load(k, String(c), "ts-program"),
          cancel: (k: string) => cs.cancel(k),
          index: () => cs.index(),
          utilization: () => cs.utilization(),
        },
      };
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
      if (this.deps.replica && this.deps.professionalRegistry && this.deps.professionalArtifacts && this.deps.professionalGrantService) {
        try {
          const professionalGrant = this.deps.professionalGrantService.issue({
            lease: { taskId: lease.taskId, leaseId: lease.leaseId, generation: lease.generation },
            scope: {
              tenantId: work.scope.tenantId,
              principalId: `worker:${this.deps.replica.workerId}`,
              roles: [role.id],
              traceId: work.scope.traceId,
              space,
            },
            workspace: lease.workspace,
            language: "ts",
            capabilities: ["professional.execute"],
            ttlMs: this.deps.professionalGrantTtlMs ?? 120_000,
          });
          capabilityInject["professional"] = createProfessionalTaskCapability({
            lease,
            work,
            worker: this.deps.replica,
            role,
            grant: professionalGrant,
            registry: this.deps.professionalRegistry,
            artifacts: this.deps.professionalArtifacts,
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
          workerId: this.deps.replica!.workerId,
          toolNames: snapshot.toolNames,
          memoryEntryIds: snapshot.memoryEntryIds,
          skillIndexIds: snapshot.skillIndexIds,
          activeSkillIds: snapshot.activeSkillIds,
          usage: snapshot.usage,
          omitted: snapshot.omitted,
          retrievalTraceIds: snapshot.retrievalTraces.map((trace) => trace.traceId),
        };
        traceEvents.push(event);
        this.deps.onTrace?.(event);
      }

      const r = await runAgentTask({
        llm,
        kernel,
        caps: taskCaps,
        task: { title: work.title, text: taskText },
        ...(goal ? { goal } : {}),
        ...(publisherClarification ? { publisherClarification } : {}),
        taskWorkspace: this.deps.workspace.dir,
        toolstore: (kernel as unknown as { toolstore?: import("@away_from/pth-kernel-interpreter").Toolstore }).toolstore,
        role,
        asp: config.aspMode,
        sessionRef,
        cache: cs,
        capabilityInject,
        toolRegistry,
        ...(cognitive ? { toolAllowlist: cognitive.policy.toolNames } : {}),
        toolRegExec: this.deps.toolRegRunChild
          ? { runChild: this.deps.toolRegRunChild, caller: { taskId: lease.taskId, roleId: role.id, tenantId: work.scope.tenantId, delivery: null } }
          : undefined,
        ...(this.deps.commandGateway
          ? {
              commandGateway: this.deps.commandGateway,
              commandContext: {
                principalId: this.deps.replica ? `worker:${this.deps.replica.workerId}` : `worker:${role.id}`,
                tenantId: work.scope.tenantId,
                roleId: role.id,
                taskId: lease.taskId,
              },
            }
          : {}),
        ...(this.deps.extraTools ? { extraTools: this.deps.extraTools } : {}),
        onStep: this.deps.onStep,
        logger: this.deps.logger,
        onTrace: (e) => {
          traceEvents.push(e);
          this.deps.onTrace?.(e);
        },
      });

      if (cognitive) {
        const snapshot = cognitive.ledger.snapshot();
        const event = {
          type: "cognitive-working-set" as const,
          phase: "finish" as const,
          taskId: lease.taskId,
          directorySnapshotId: cognitive.policy.directorySnapshotId,
          workerId: this.deps.replica!.workerId,
          toolNames: snapshot.toolNames,
          memoryEntryIds: snapshot.memoryEntryIds,
          skillIndexIds: snapshot.skillIndexIds,
          activeSkillIds: snapshot.activeSkillIds,
          usage: snapshot.usage,
          omitted: snapshot.omitted,
          retrievalTraceIds: snapshot.retrievalTraces.map((trace) => trace.traceId),
        };
        traceEvents.push(event);
        this.deps.onTrace?.(event);
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

    if (llm) {
      // Wave 4：pulse 是一等模式——translate/result 事件写入 trace/transcript。
      const traceEvents: AgentTraceEvent[] = [];
      const tStart = Date.now();
      const t = await translateTask({ llm }, { title: work.title, text: work.text });
      const translateEvent: AgentTraceEvent = t.ok
        ? { type: "pulse-translate", step: 0, ok: true, codeLength: t.code.length }
        : { type: "pulse-translate", step: 0, ok: false, error: t.error };
      traceEvents.push(translateEvent);
      this.deps.onTrace?.(translateEvent);
      if (aborted()) {
        return { lease: ref, status: "cancelled", retryable: true, error: { code: "cancelled", message: "cancelled during translation" }, artifacts: [], traceId };
      }
      if (!t.ok) {
        return { lease: ref, status: "rejected", retryable: false, error: { code: "nl-translate-failed", message: t.error }, artifacts: [], traceId };
      }
      const raw = (await runPtcProgram({ code: t.code, cwd: this.deps.workspace.dir, ts: kernel.ts })).raw;
      const resultEvent: AgentTraceEvent = {
        type: "pulse-result",
        step: 0,
        ok: raw.ok,
        ...(raw.ok ? { valuePreview: JSON.stringify(raw.value ?? null).slice(0, 200) } : { error: raw.error?.message ?? "unknown" }),
        code: t.code,
        durationMs: Date.now() - tStart,
      };
      traceEvents.push(resultEvent);
      this.deps.onTrace?.(resultEvent);
      if (aborted()) {
        return { lease: ref, status: "cancelled", retryable: true, error: { code: "cancelled", message: "cancelled during ptc execution" }, artifacts: [], traceId };
      }
      if (!raw.ok) {
        // W8 P2：tasks.await 挂起信号 → retryable requeue（释放认领；子终态事件触发重跑）
        if (raw.error?.code === TASK_AWAIT_SUSPENDED_CODE) {
          return {
            lease: ref,
            status: "rejected",
            retryable: true,
            error: { code: TASK_AWAIT_SUSPENDED_CODE, message: raw.error.message },
            result: raw,
            artifacts: [],
            traceId,
          };
        }
        return {
          lease: ref,
          status: "rejected",
          retryable: false,
          error: { code: "execution-failed", message: raw.error?.message ?? "unknown execution error" },
          result: raw,
          artifacts: [],
          traceId,
        };
      }
      return { lease: ref, status: "completed", result: raw, artifacts: [], traceId };
    }

    return {
      lease: ref,
      status: "rejected",
      retryable: false,
      error: { code: "no-llm", message: "任务池为自然语言池（agent/translate 均需 LLM）——直连执行请走 /kernel/exec 通道" },
      artifacts: [],
      traceId,
    };
  }
}
