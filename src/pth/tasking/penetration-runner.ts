/**
 * tasking/penetration-runner.ts —— 0.16.3 穿透执行面（W8 P3 后续，2026-08-18）。
 *
 * 穿透 = 类型树上的固化捷径边：父 worker 在任务内**直接调用子 agent**（同进程嵌套
 * agent-loop），跳过逐级派发与任务池往返（0.16.3）。本模块是编排核：
 *
 *   调用链：ts 程序 tasks.penetrate（capability 注入）
 *     → PenetrationRunner.penetrate（本模块——校验 + 编排）
 *     → deps.runChild（bootstrap 装配——建子 kernel + 嵌套 runAgentTask + dispose）
 *
 * 用户裁决（2026-08-18）：
 *   P1 显式原语 tasks.penetrate（不做 delegate 透明加速——语义清晰）；
 *   P2 子 agent 步数计入父任务计量面 + 穿透深度限 1（嵌套子 kernel 不注入
 *      penetration 端口——子 agent 无法二次穿透；预算经济化后续细化）；
 *   P3 本批只做执行面（稳定路径自动发现→提案通道后续；注册仍走 memory-keeper 维护面）；
 *   P4 穿透失败报错由父决策（不自动回退 delegate；产物契约 v1 文档级不机器校验）。
 *
 * 执行期校验（机器校验不信任 skill 自报——与注册校验同源）：
 *   1. 调用者任务上下文就绪（task-loop 盖章，不可自报）；
 *   2. 目标角色已注册（knownRoleById）；
 *   3. 组织权矩阵实时重验（allowedDelegationTargets——角色可能已演化）；
 *   4. skill:penetrate:<to> 条目存在且 status=official（draft 不可执行——审批后才生效）；
 *   5. 机读边 parent 必须等于调用方角色（skill id 按 child 寻址，边属特定 parent→child）。
 */

import type { TaskDispatchContext, TaskPenetrateInput, TaskPenetrateResult, TenantScope } from "../contracts/index.js";
import { PtcContractError } from "../kernel/ptc/contract.js";
import { knownRoleById } from "../kernel/execution/worker-cluster.js";
import { allowedDelegationTargets } from "./delegation-policy.js";
import {
  PENETRATION_SKILL_ID_PREFIX,
  parsePenetrationSkillContent,
} from "./penetration-skill.js";

/** 嵌套子 agent 执行请求（bootstrap 装配的 runChild 消费） */
export interface PenetrationRunChildRequest {
  childRoleId: string;
  title: string;
  /** 已合成任务文本（输入/产物契约 + 调用方 text/context） */
  text: string;
  /** 穿透 skill 的输入/产物契约（runChild 可用于 prompt 合成/审计） */
  inputContract: string;
  outputContract: string;
  /** 穿透 skill 条目 id（审计/轨迹标注） */
  skillId: string;
  caller: TaskDispatchContext;
}

export interface PenetrationRunChildResult {
  ok: boolean;
  value?: unknown;
  summary?: string;
  steps: number;
  error?: string;
  durationMs: number;
}

/** 嵌套执行缝（bootstrap 注入——建子 kernel/跑 agent-loop/dispose 全在其内） */
export type PenetrationRunChild = (req: PenetrationRunChildRequest) => Promise<PenetrationRunChildResult>;

/** 记忆读取窄口（结构型——PgMemoryStore.get 兼容） */
export interface PenetrationMemoryLike {
  get(id: string): Promise<{ id: string; kind: string; status?: string; content: string } | undefined>;
}

export interface PenetrationRunner {
  penetrate(input: TaskPenetrateInput, caller: TaskDispatchContext, scope: TenantScope): Promise<TaskPenetrateResult>;
}

export function createPenetrationRunner(deps: {
  memory: PenetrationMemoryLike;
  runChild: PenetrationRunChild;
}): PenetrationRunner {
  return {
    async penetrate(input, caller, _scope) {
      if (!caller || !caller.taskId || !caller.roleId) {
        throw new PtcContractError("tasks.penetrate", "任务上下文未就绪——tasks.penetrate 仅可在任务程序内调用");
      }
      const to = String(input?.to ?? "").trim();
      if (!to) throw new PtcContractError("tasks.penetrate", "to 必须是非空字符串");
      // 2. 目标角色已注册
      if (!knownRoleById(to)) {
        throw new PtcContractError("tasks.penetrate", `穿透目标角色未注册: ${to}`);
      }
      // 3. 组织权实时重验（执行期——角色谱系可能已演化，注册时通过不等于现在合法）
      const allowed = allowedDelegationTargets(caller.roleId);
      if (!allowed.includes(to)) {
        throw new PtcContractError(
          "tasks.penetrate",
          `组织权拒绝：${caller.roleId} 不可投递 ${to}（可投递: ${allowed.length > 0 ? allowed.join("/") : "无"}）`,
        );
      }
      // 4. 穿透 skill 条目存在且 official（draft = 未审批——不可执行）
      const skillId = `${PENETRATION_SKILL_ID_PREFIX}${to}`;
      const entry = await deps.memory.get(skillId);
      if (!entry) {
        throw new PtcContractError(
          "tasks.penetrate",
          `穿透边未注册：${caller.roleId}→${to} 无 ${skillId} 条目——请改用 tasks.delegate 或先经治理通道注册穿透 skill`,
        );
      }
      if (entry.status !== "official") {
        throw new PtcContractError(
          "tasks.penetrate",
          `穿透边未生效：${skillId} status=${entry.status ?? "?"}（draft 待审批/archived 已退役——仅 official 可执行）`,
        );
      }
      // 5. 机读边 parent = 调用方（skill 按 child 寻址——边属特定 parent→child，冒用拒绝）
      const parsed = parsePenetrationSkillContent(entry.content);
      if (!parsed.ok) {
        throw new PtcContractError("tasks.penetrate", `穿透 skill 内容非法（${skillId}）：${parsed.error}`);
      }
      if (parsed.spec.parent !== caller.roleId) {
        throw new PtcContractError(
          "tasks.penetrate",
          `穿透边归属不符：${skillId} 注册边 ${parsed.spec.parent}→${to}，调用方 ${caller.roleId} 不在边上`,
        );
      }
      // 合成子任务文本：契约前置（子 agent 明确输入/产物形状）+ 调用方自包含描述
      const contextBlock = input.context && Object.keys(input.context).length > 0
        ? `\n\n【附加上下文】\n${JSON.stringify(input.context, null, 2)}`
        : "";
      const text = [
        `【穿透调用】${caller.roleId} → ${to}（${skillId}——跳过任务池的固化捷径边）`,
        `【输入契约】${parsed.spec.inputContract}`,
        `【产物契约】${parsed.spec.outputContract}（done.result 必须满足）`,
        "",
        String(input.text ?? "").trim(),
      ].join("\n") + contextBlock;
      const started = Date.now();
      const r = await deps.runChild({
        childRoleId: to,
        title: String(input.title ?? "").trim() || `穿透:${to}`,
        text,
        inputContract: parsed.spec.inputContract,
        outputContract: parsed.spec.outputContract,
        skillId,
        caller,
      });
      // P4：失败报错由父决策（不自动回退 delegate——父 worker 自行 catch 决定重试/回退）
      if (!r.ok) {
        throw new PtcContractError(
          "tasks.penetrate",
          `穿透执行失败（${caller.roleId}→${to}）：${r.error ?? "子 agent 未产出结果"}`,
        );
      }
      return {
        ok: true,
        value: r.value,
        summary: r.summary,
        steps: r.steps,
        childRole: to,
        durationMs: r.durationMs ?? Date.now() - started,
      };
    },
  };
}
