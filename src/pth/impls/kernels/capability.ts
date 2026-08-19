import type pg from "pg";
import type { LlmFn } from "../../kernel/interpreter/llm-fn.js";
import type { Interpreter } from "@away_from/pth-sandbox";
import type { DataWorldAccess } from "../../kernel/storage/index.js";
import { DEFAULT_TENANT_ID, withMemoryTenant, type PgMemoryStore } from "@away_from/pth-memory";
import type { Toolstore } from "../../kernel/interpreter/toolstore.js";
import { buildExtensions } from "../../kernel/extensions/index.js";
import { createExtCapability } from "../../kernel/interpreter/ext-capability.js";
import { wrapValidated, PtcContractError } from "../../kernel/ptc/contract.js";
import type {
  TaskAwaitInput,
  TaskAwaitResult,
  TaskDelegateInput,
  TaskDelegateResult,
  TaskDispatchContext,
  TaskPenetrateInput,
  TaskPenetrateResult,
  TenantScope,
} from "../../contracts/index.js";
import { filterVisibleEntries, listSkills, getSkill, maintainSkillWrite, maintainSkillArchive, proposeSkillMaintenance, reviewSkillProposal, reviewToolProposal } from "@away_from/pth-memory";
import { validatePenetrationSkillRegistration, PENETRATION_SKILL_NAME_PREFIX } from "../../tasking/index.js";
import {
  createPgKnowledgeVerificationRepo,
  promoteKnowledgeEntry,
  recordKnowledgeVerdict,
  type KnowledgeVerificationRepo,
} from "../../execution/knowledge-promotion.js";
import { pthConfig } from "../../config/index.js";
import {
  defaultWebLookup,
  defaultWebRequest,
  secureWebFetch,
  WEB_MAX_BYTES,
  WEB_MAX_REDIRECTS,
  WEB_TIMEOUT_MS,
  type WebLookup,
  type WebRequest,
} from "./web-transport.js";

/** 任务工作区文件面（fs.task——白名单相对路径 + 防穿越） */
function createTaskFs(resolve: (rel: string) => string): Record<string, unknown> {
  return {
    write: async (relPath: string, content: string) => {
      const abs = resolve(relPath);
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(abs.split("/").slice(0, -1).join("/") || abs, { recursive: true });
      await writeFile(abs, content, "utf8");
      return { ok: true, path: relPath, bytes: Buffer.byteLength(content) };
    },
    read: async (relPath: string) => {
      const abs = resolve(relPath);
      const { readFile } = await import("node:fs/promises");
      return await readFile(abs, "utf8");
    },
    list: async () => {
      const { readdir } = await import("node:fs/promises");
      const base = resolve(".");
      const entries = await readdir(base, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    },
  };
}

/**
 * W8 P1：tasks.delegate/await 的窄端口（TaskControlService 实现；仅组织权持有角色注入）。
 */
export interface TaskDispatchPort {
  delegate(input: TaskDelegateInput, caller: TaskDispatchContext, scope: TenantScope): Promise<TaskDelegateResult>;
  awaitTask(input: TaskAwaitInput, caller: TaskDispatchContext, scope: TenantScope): Promise<TaskAwaitResult>;
}

/**
 * 0.16.3 穿透执行端口（PenetrationRunner 实现；仅组织权持有角色注入——与 taskControl 同批装配）。
 * 嵌套子 kernel 不传本端口 → 穿透深度限 1（用户裁决 P2）。
 */
export interface PenetrationPort {
  penetrate(input: TaskPenetrateInput, caller: TaskDispatchContext, scope: TenantScope): Promise<TaskPenetrateResult>;
}

/**
 * 能力注入：context 默认空，只注入白名单。
 * 不注入 fs/child_process/net——语言层面无能力。
 * 任务动词面收窄：tasks 只暴露 peek/submit（claim/reject 由 TaskLoop 机械控制）。
 */
export function buildCapabilities(deps: {
  llm: LlmFn;
  dataWorld: DataWorldAccess;
  bash?: Interpreter;
  python?: Interpreter;
  c?: Interpreter;   // 编译核（C——sandbox 侧编译-运行）
  /** toolstore 文件通道（§0.5）：注入 fs.readText（只读 toolstore 目录） */
  toolstore?: Toolstore;
  /** 环境感知（env.inspect）：按语言返回 kernel 状态摘要（LLM 友好版——变量/函数概览） */
  inspect?: (lang?: string) => Promise<unknown>;
  /** 新执行核注册（ext.kernel 接线——createWorkerKernelWithManager 透传 manager.registerKernel） */
  registerKernel?: (language: string, interpreter: unknown) => void;
  /** 自修改（v1）：只读 PTH 源码——(relPath) => Promise<string>——白名单/路径校验 */
  readSource?: (relPath: string) => Promise<string>;
  /** 任务工作区（workspace 收敛——自修改产物落盘）：(relPath) => 绝对路径解析——fs.task 用 */
  taskWorkspaceResolve?: (relPath: string) => string;
  /** ASP 会话空间引用（可见性盖章/过滤——任务级；agent-loop cd 更新） */
  sessionRef?: { current: { currentSpace: string } | null };
  /** 角色 ID（B4 Phase 3：skills.maintain 仅注入 memory-keeper） */
  roleId?: string;
  /** W8 P1：任务投递端口（仅组织权持有角色传入；缺省不注入 tasks 键） */
  taskControl?: TaskDispatchPort;
  /** 0.16.3：穿透执行端口（与 taskControl 同批装配；缺省不注入 tasks.penetrate） */
  penetration?: PenetrationPort;
  /** L2：活动事件上报（skill.proposal.created 等——batch-process 注入 IPC 转发闭包） */
  onActivity?: (e: { kind: string; role?: string; detail?: string; at: number }) => void;
  /** W8 P1：当前任务身份（task-loop 每任务盖章——delegate/await 的调用者上下文） */
  taskContext?: { current: TaskDispatchContext | null };
  /** R3/P1-2：verification repo 注入缝（测试/非 PG 装配传内存 repo；缺省从 PgMemoryStore 派生） */
  verificationRepo?: KnowledgeVerificationRepo;
}): Record<string, unknown> {
  // 标准扩展包（memory/context/model——SPEC 2026-08-09）：能力注入 + 预置对象
  // N14 P3：onActivity 透传 ExtContext（manage.tool.register 的 tool.proposal.created 事件源）
  const ext = buildExtensions({
    dataWorld: deps.dataWorld,
    toolstore: deps.toolstore,
    sessionRef: deps.sessionRef,
    onActivity: deps.onActivity,
    taskContext: deps.taskContext,
  });
  // 管理面裁剪（权限 v2 R3——2026-08-10）：worker 执行面只给只读子集——
  //   perf.set/publish/apply（运行时调参/策略）与 model.set（切模型）是管理面写操作，不进注入面；
  //   tasks（peek/submit）整体摘除（task-loop 内部走 store——vm 暴露是历史遗留面）。
  //   系统组件（autopilot/console/lineage）主进程直调，不经能力注入——不受影响。
  const extCaps = { ...ext.capabilities } as Record<string, unknown>;
  // PTC 契约校验接线（2026-08-14 A1 Phase 1）：注册表 validate 的能力函数包一层参数校验
  const memRaw = extCaps["memory"] as Record<string, (...a: unknown[]) => unknown> | undefined;
  if (memRaw) {
    if (memRaw["query"]) memRaw["query"] = wrapValidated("memory.query", memRaw["query"]);
    if (memRaw["write"]) memRaw["write"] = wrapValidated("memory.write", memRaw["write"]);
  }
  const perfFull = extCaps["perf"] as Record<string, unknown> | undefined;
  if (perfFull) extCaps["perf"] = { params: perfFull["params"], status: perfFull["status"], analyze: perfFull["analyze"], list: perfFull["list"] };
  const modelFull = extCaps["model"] as Record<string, unknown> | undefined;
  if (modelFull) extCaps["model"] = { get: modelFull["get"], usage: modelFull["usage"] };
  // F2（AB-01）：pth-memory 治理函数只接收 store 形参——按当前任务 tenant 包装 requireTenant store。
  const memoryStore = () => withMemoryTenant(deps.dataWorld.memory, deps.taskContext?.current?.tenantId ?? DEFAULT_TENANT_ID);
  // R3/P1-2：worker 路径同样走 service 层强制授权。verdict 落持久 plan/verdict rows。
  // 注入缝：deps.verificationRepo 优先（测试/非 PG 装配传内存 repo）；
  // 缺省从 PgMemoryStore 的 pg.Pool 派生（生产 worker 恒有）；两者皆无 → fail-closed 清晰报错。
  const verificationPool = (deps.dataWorld.memory as unknown as { pool?: pg.Pool }).pool;
  const verificationRepo = deps.verificationRepo
    ?? (verificationPool ? createPgKnowledgeVerificationRepo(verificationPool) : null);
  return {
    ...extCaps,
    // 扩展编排面（2026-08-09 用户裁决：代码库式扩展 + 公共记忆区索引——无注册装载）
    ...createExtCapability({
      toolstore: deps.toolstore!,
      memory: (ext.capabilities["memory"] as { write: (e: { kind: string; content: string; anchors: string[] }) => Promise<unknown> } | undefined),
      // 2026-08-15 审计修复：extension-index 属 prompt 层系统资产，worker 面 memory.write 只读；
      // syncIndex 走 PgMemoryStore force 系统通道（固定 id/kind，内容来自 toolstore 扫描）——
      // 否则 ext.syncIndex 永远被用途层策略拒绝。
      writeSystemIndex: async (entry) => {
        await (deps.dataWorld.memory as PgMemoryStore).write({ ...entry, tenantId: DEFAULT_TENANT_ID } as never, { force: true });
      },
      registerKernel: deps.registerKernel,
      // 2026-08-15 筛查 M3：ext.db.query 契约是 (table, sql)，且开放 tasks/transcripts 模板面——
      // 此前把 queryReadOnly 单参实现误当双参通道注入，首个参数被当 SQL
      dbQuery: (_table: string, sql: string) => deps.dataWorld.queryTemplate?.(sql) ?? Promise.resolve([]),
    }),
    llm: deps.llm,
    web: { fetchText: wrapValidated("web.fetchText", createWebCapability().fetchText) },
    ...(deps.inspect ? { env: { inspect: wrapValidated("env.inspect", deps.inspect) } } : {}),
    // 召回能力（T6）：后续任务从记忆区召回工具函数/洞察——扁平化闭环（agent 状态 = 记忆文档）
    // 2026-08-15 筛查 H5：召回面同样按会话空间过滤（raw retrieve 会绕过可见性）
    state: createRecallState(deps.dataWorld.memory, deps.sessionRef, deps.taskContext),
    // 文件通道（§0.5）：fs.readText 只读 toolstore + fs.list 枚举可用工具
    ...(deps.toolstore
      ? { fs: {
          readText: wrapValidated("fs.readText", deps.toolstore.readText.bind(deps.toolstore)),
          list: deps.toolstore.list.bind(deps.toolstore),
          // 自修改（v0.8→v0.9 铺垫）：readSource 只读 PTH 源码（/app/src 白名单——
          // 路径校验防越权；worker 读源码 → sandbox 编码 → 提交补丁产物）
          readSource: deps.readSource ? wrapValidated("fs.readSource", deps.readSource) : undefined,
          // 任务工作区（workspace 收敛 2026-08-09）：ts 程序写文件落 tasks/<taskId>/——
          // 自修改产物（补丁/源码）落盘 → archive 归档。白名单：相对路径 + 防穿越
          ...(deps.taskWorkspaceResolve
            ? { task: createTaskFs(deps.taskWorkspaceResolve) }
            : {}),
        } }
      : {}),
    skills: {
      // B4 Phase 2（2026-08-15 已裁 C 两级检索）：
      //   Level 0 = list() 三要素清单；Level 1 = get(id) 全文
      // K1a 知识正确性收口：draft 与 archived 都不进 worker 面（治理查询走 store/其它通道）
      list: async () => (await listSkills(memoryStore())).filter((s) => s.status === "official"),
      get: async (name: string) => getSkill(memoryStore(), String(name)),
      // B4 Phase 3：维护面只给 memory-keeper（写后冻结；修订 = force + audit / archive + 新条目）
      //   W5 策略：PTH_SKILL_WRITE_POLICY=manual（默认人工闸门）| staged（提案→审核→批准→执行）
      ...(deps.roleId === "memory-keeper"
        ? {
            maintain: {
              write: async (input: { name: string; content: string; anchors?: string[]; force?: boolean; audit?: string; proposalId?: string }) => {
                // W8 P3：穿透 skill 注册校验（组织权矩阵——parent→child 必须是合法投递边）
                if (String(input.name ?? "").startsWith(PENETRATION_SKILL_NAME_PREFIX)) {
                  const v = validatePenetrationSkillRegistration(input.content);
                  if (!v.ok) throw new PtcContractError("skills.maintain.write", v.error);
                }
                return maintainSkillWrite(memoryStore(), input, { policy: pthConfig().str("PTH_SKILL_WRITE_POLICY") as "manual" | "staged" });
              },
              archive: async (id: string, audit?: string) =>
                maintainSkillArchive(memoryStore(), id, audit, { policy: pthConfig().str("PTH_SKILL_WRITE_POLICY") as "manual" | "staged" }),
              propose: async (input: { action: "write" | "archive"; name: string; content?: string; force?: boolean; anchors?: string[]; audit?: string }) => {
                // W8 P3：提案阶段同样先过穿透注册校验（调用即拒绝——不进 proposal 池）
                if (input.action === "write" && String(input.name ?? "").startsWith(PENETRATION_SKILL_NAME_PREFIX)) {
                  if (typeof input.content !== "string" || input.content.trim() === "") {
                    throw new PtcContractError("skills.maintain.propose", "穿透 skill 提案必须携带 content");
                  }
                  const v = validatePenetrationSkillRegistration(input.content);
                  if (!v.ok) throw new PtcContractError("skills.maintain.propose", v.error);
                }
                const r = await proposeSkillMaintenance(memoryStore(), input);
                // L2（2026-08-18 用户裁决 Q2）：提案落库即发事件——trigger-engine 监听
                // skill.proposal.created → 自动派发 controller:adversarial 审核任务（事件驱动编排）
                if (r.ok && r.id) {
                  deps.onActivity?.({
                    kind: "skill.proposal.created",
                    role: deps.roleId,
                    detail: r.id,
                    at: Date.now(),
                  });
                }
                return r;
              },
            },
          }
        : {}),
      // B4 W7：对抗性审核只给 controller:adversarial
      ...(deps.roleId === "controller:adversarial"
        ? {
            review: async (proposalId: string, verdict: "pass" | "reject", note?: string) =>
              reviewSkillProposal(memoryStore(), proposalId, verdict, note ?? ""),
          }
        : {}),
    },
    // N14 P3：工具注册提案对抗性审核（与 skills.review 同构——controller:adversarial 专属；
    // 审核对象 kind=tool-proposal——schema 质量/执行体安全/作弊捷径）
    ...(deps.roleId === "controller:adversarial"
      ? {
          tools: {
            review: async (proposalId: string, verdict: "pass" | "reject", note?: string) =>
              reviewToolProposal(memoryStore(), proposalId, verdict, note ?? ""),
          },
        }
      : {}),
    // K4 Phase 4（N22 3）：候选验证与晋升闭环的写能力按角色注入——
    //   controller:adversarial → knowledge.review（对抗 verdict）；
    //   memory-keeper → knowledge.promote；
    //   其它角色无 knowledge 写能力（读走 K3 broker 只读 official）。
    ...(deps.roleId === "controller:adversarial"
      ? {
          knowledge: {
            review: async ({ planId, checkId, expectedCandidateRevision, verdict, note }: {
              planId: string; checkId: string; expectedCandidateRevision: number; verdict: "pass" | "reject"; note: string;
            }) => {
              if (!verificationRepo) return { ok: false, error: "verification backend unavailable（缺少 verificationRepo 注入且 memory store 无 pg pool）" };
              const tenantId = deps.taskContext?.current?.tenantId ?? DEFAULT_TENANT_ID;
              const taskId = deps.taskContext?.current?.taskId;
              return recordKnowledgeVerdict(memoryStore(), verificationRepo, planId, checkId, expectedCandidateRevision, {
                kind: "adversarial",
                verdict,
                reviewerRole: "controller:adversarial",
                note,
                at: Date.now(),
              }, {
                principalId: "worker:controller:adversarial",
                executionId: taskId ?? `worker:controller:adversarial:${process.pid}`,
                roleId: "controller:adversarial",
              }, { tenantId });
            },
          },
        }
      : {}),
    ...(deps.roleId === "memory-keeper"
      ? {
          knowledge: {
            promote: async ({ entryId, planId, expectedCandidateRevision }: {
              entryId: string; planId: string; expectedCandidateRevision: number;
            }) => {
              if (!verificationRepo) return { ok: false, error: "verification backend unavailable（缺少 verificationRepo 注入且 memory store 无 pg pool）" };
              const tenantId = deps.taskContext?.current?.tenantId ?? DEFAULT_TENANT_ID;
              const taskId = deps.taskContext?.current?.taskId;
              return promoteKnowledgeEntry(memoryStore(), verificationRepo, entryId, planId, expectedCandidateRevision, {
                principalId: "worker:memory-keeper",
                executionId: taskId ?? `worker:memory-keeper:${process.pid}`,
                roleId: "memory-keeper",
              }, {
                tenantId,
                promoterRole: "memory-keeper",
              });
            },
          },
        }
      : {}),
    // W8 P1：任务投递原语——仅组织权持有角色注入（batch-process 按 delegation-policy 传 taskControl）。
    // 调用者身份来自 task-loop 每任务盖章的 taskContext（worker 不可自报）。
    ...(deps.taskControl
      ? {
          tasks: {
            delegate: wrapValidated("tasks.delegate", async (input: TaskDelegateInput) => {
              const ctx = deps.taskContext?.current;
              if (!ctx || !ctx.taskId || !ctx.roleId) {
                throw new PtcContractError("tasks.delegate", "任务上下文未就绪——tasks.delegate 仅可在任务程序内调用");
              }
              const scope: TenantScope = {
                tenantId: ctx.tenantId,
                principalId: ctx.worker ? `worker:${ctx.worker.workerId}` : `worker:${ctx.roleId}`,
                roles: [ctx.roleId],
                traceId: `task:${ctx.taskId}`,
              };
              return deps.taskControl!.delegate(input, ctx, scope);
            }),
            await: wrapValidated("tasks.await", async (input: TaskAwaitInput) => {
              const ctx = deps.taskContext?.current;
              if (!ctx || !ctx.taskId || !ctx.roleId) {
                throw new PtcContractError("tasks.await", "任务上下文未就绪——tasks.await 仅可在任务程序内调用");
              }
              const scope: TenantScope = {
                tenantId: ctx.tenantId,
                principalId: ctx.worker ? `worker:${ctx.worker.workerId}` : `worker:${ctx.roleId}`,
                roles: [ctx.roleId],
                traceId: `task:${ctx.taskId}`,
              };
              return deps.taskControl!.awaitTask(input, ctx, scope);
            }),
            /** W8 P2：挂起重跑续接原语——读取本任务已回流的 childResult/等待登记（task-loop 盖章） */
            resume: wrapValidated("tasks.resume", async () => {
              const ctx = deps.taskContext?.current;
              if (!ctx || !ctx.taskId) {
                throw new PtcContractError("tasks.resume", "任务上下文未就绪——tasks.resume 仅可在任务程序内调用");
              }
              return { waiting: ctx.dispatchWait ?? {}, results: ctx.childResult ?? {} };
            }),
            // 0.16.3 穿透原语：仅装配了 penetration 端口时注入（嵌套子 kernel 无此端口——深度限 1）
            ...(deps.penetration
              ? {
                  penetrate: wrapValidated("tasks.penetrate", async (input: TaskPenetrateInput) => {
                    const ctx = deps.taskContext?.current;
                    if (!ctx || !ctx.taskId || !ctx.roleId) {
                      throw new PtcContractError("tasks.penetrate", "任务上下文未就绪——tasks.penetrate 仅可在任务程序内调用");
                    }
                    const scope: TenantScope = {
                      tenantId: ctx.tenantId,
                      principalId: ctx.worker ? `worker:${ctx.worker.workerId}` : `worker:${ctx.roleId}`,
                      roles: [ctx.roleId],
                      traceId: `task:${ctx.taskId}`,
                    };
                    return deps.penetration!.penetrate(input, ctx, scope);
                  }),
                }
              : {}),
          },
        }
      : {}),
    // tasks peek/submit 面仍摘除（权限 v2 R3）——任务代码只可走 delegate/await 原语，不可直连任务池
    ...(deps.bash ? { bash: deps.bash } : {}),
    ...(deps.python ? { python: deps.python } : {}),
    // 2026-08-11 生产核裁决：ts 程序内 c.* 能力全部撤销（"不应在 ts 空间内调用 C"）——
    // C 产物编写/构建/运行/单元管理全归 dev 空间动作工具（dev.write/edit/build/run/save/list）。
  };
}

/**
 * web 能力（网络搜寻任务 1）：受限只读 fetch——vm 内任务可获取 URL 文本。
 * 安全边界（对齐能力白名单模型）：
 *  - 仅 http/https 协议（防 file:// 等本地读取）
 *  - 仅 GET（无写能力）
 *  - 响应大小上限（默认 256KB——防内存放大）
 *  - 超时（默认 30s）
 *  - 返回纯文本（剥离 HTML 标签——官方文档页可用）
 */
export interface WebCapability {
  fetchText(url: string, opts?: { maxBytes?: number; timeoutMs?: number }): Promise<string>;
}

// ─── 安全传输（N29 Task 4：抽取到 impls/kernels/web-transport.ts 共用） ───
// 公共面保持不变：既有消费者从本文件 import 的传输符号原样再导出，
// `web.fetchText(): Promise<string>` 的签名、默认预算与错误消息一律不变。
export type {
  ResolvedAddress,
  WebLookup,
  WebResponse,
  WebRequest,
  WebTimerApi,
} from "./web-transport.js";
export {
  assertPublicResolvedAddresses,
  defaultWebLookup,
  defaultWebRequest,
  readWebBody,
  readWebBodyBytes,
  secureWebFetch,
} from "./web-transport.js";

export interface WebCapabilityOptions {
  lookup?: WebLookup;
  request?: WebRequest;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function createWebCapability(opts: WebCapabilityOptions = {}): WebCapability {
  const lookup = opts.lookup ?? defaultWebLookup;
  const request = opts.request ?? defaultWebRequest;
  return {
    async fetchText(url, opts = {}) {
      const res = await secureWebFetch(url, {
        maxBytes: opts.maxBytes ?? WEB_MAX_BYTES,
        timeoutMs: opts.timeoutMs ?? WEB_TIMEOUT_MS,
        maxRedirects: WEB_MAX_REDIRECTS,
        lookup,
        request,
      });
      const text = new TextDecoder().decode(res.rawBytes);
      // 内容类型判定：HTML 剥标签，其余原样
      const ctype = res.headers["content-type"] ?? "";
      return /html/i.test(ctype) ? stripHtml(text) : text;
    },
  };
}


/**
 * 召回能力（解释器持久化层 T6）：state.recallFunctions / recallInsights
 * 后续任务从记忆区召回：
 *   - 工具函数（tool-function：content=源码，meta.spec=构造文档）——eval 重放或按 spec 重建
 *   - 经验/洞察（task-insight：content=文本）
 * 只读（检索记忆），无写——写走 memory 能力（任务代码显式）。
 */
export interface RecallState {
  recallFunctions(anchors: string[], opts?: { limit?: number }): Promise<
    Array<{ key: string; source: string; spec: unknown }>
  >;
  recallInsights(anchors: string[], opts?: { limit?: number }): Promise<string[]>;
}

export function createRecallState(
  memory: Pick<PgMemoryStore, "retrieve">,
  sessionRef?: { current: { currentSpace: string } | null },
  taskContext?: { current: { tenantId?: string } | null },
): RecallState {
  const visible = <T extends { meta?: unknown }>(entries: T[]): T[] =>
    filterVisibleEntries(entries, sessionRef?.current?.currentSpace);
  const tenantId = () => taskContext?.current?.tenantId ?? DEFAULT_TENANT_ID;
  return {
    async recallFunctions(anchors, opts = {}) {
      const entries = visible(await memory.retrieve({ anchors, kinds: ["tool-function"], status: ["official"], tenantId: tenantId() }));
      return entries.slice(0, opts.limit ?? 5).map((e) => ({
        key: (e.anchors[0] ?? e.id).replace(/^fn-/, ""),
        source: e.content,
        spec: e.meta?.spec ?? null,
      }));
    },
    async recallInsights(anchors, opts = {}) {
      const entries = visible(await memory.retrieve({ anchors, kinds: ["task-insight"], status: ["official"], tenantId: tenantId() }));
      return entries.slice(0, opts.limit ?? 10).map((e) => e.content);
    },
  };
}
