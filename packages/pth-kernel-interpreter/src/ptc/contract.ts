/**
 * ptc/contract.ts —— PTC 契约注册表（2026-08-14 A1 Phase 1——契约类型化）。
 *
 * 目标（docs/pth/backlog-priority.md 附录 A）：把 LLM↔核 的隐式契约显式化——
 * 能力函数面从四处散落（capability.ts 大工厂 / parse-agent-action 手拼降级模板 /
 * 散文式能力文档）收敛为**单一真相源注册表**。
 *
 * 每个 def 携带：
 *   params/returnType —— TS 签名（契约文档 / 未来 d.ts 预置用）；
 *   anchor/whenToUse/effect —— 三要素（T8 锚点标准——Phase 2 能力索引生成器的数据源）；
 *   validate —— 零依赖手写参数校验（PtcContractError——结构化错误替代裸 TypeError）；
 *   asAction —— 能力函数被误当动作工具时的降级程序生成器（parse-agent-action 消费，
 *     输出与旧手写模板逐字节一致）。
 *
 * 归属核（family）：ts-local（vm 内对象）/ memory / llm / web / fs / env / state /
 * cache（task-loop 注入）/ kernel（bash·python 解释器）/ seed（results·context 预置对象）/
 * tasks（W8 父→子任务投递原语）。
 */

export type PtcFamily =
  | 'ts-local' | 'memory' | 'llm' | 'web' | 'fs' | 'env' | 'state' | 'cache' | 'kernel' | 'seed' | 'tasks'
  | 'dev' | 'write' | 'debug' | 'loop';

/** 能力宿主声明（ADR-0004：一切入口归一为代码后的执行面归属） */
export type PtcCapabilityHost = 'kernel-ts' | 'loop' | 'sandbox-debug' | 'toolstore';

export interface PtcCapabilityDef {
  name: string;
  family: PtcFamily;
  /** 参数签名（TS 形参串） */
  params: string;
  /** 返回类型（TS 类型串） */
  returnType: string;
  /** 三要素（T8）：场景锚点 */
  anchor: string;
  /** 三要素（T8）：何时用 */
  whenToUse: string;
  /** 三要素（T8）：效果预告 */
  effect: string;
  /** 参数校验（零依赖手写）——缺省不校验 */
  validate?: (args: unknown[]) => void;
  /** 能力函数被误当动作工具时的降级程序生成器 */
  asAction?: (args: Record<string, unknown>) => string;
  /** 契约注释（如 Phase 3 dispose 制动点标注） */
  note?: string;
  /** 宿主声明（ADR-0004：kernel ts / loop / sandbox-debug / toolstore） */
  host?: PtcCapabilityHost;
  /** 工具投影 schema（tool-call 面由此派生——W0 消除 PTC_TOOL_DEFS 双源） */
  toolSchema?: {
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** 契约校验错误（结构化——capability + reason 可读） */
export class PtcContractError extends Error {
  readonly capability: string;
  constructor(capability: string, reason: string) {
    super('[' + capability + '] 契约校验失败：' + reason);
    this.name = 'PtcContractError';
    this.capability = capability;
  }
}

function requireString(args: unknown[], idx: number, what: string): string {
  const v = args[idx];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new PtcContractError(what, '参数 ' + idx + ' 必须是非空字符串（got: ' + (v === null ? 'null' : typeof v) + '）');
  }
  return v;
}

function requireObject(args: unknown[], idx: number, what: string): Record<string, unknown> {
  const v = args[idx];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new PtcContractError(what, '参数 ' + idx + ' 必须是对象（got: ' + (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v) + '）');
  }
  return v as Record<string, unknown>;
}

function optionalString(args: unknown[], idx: number, what: string): void {
  const v = args[idx];
  if (v !== undefined && typeof v !== 'string') {
    throw new PtcContractError(what, '参数 ' + idx + ' 可选——若提供必须是字符串（got: ' + (v === null ? 'null' : typeof v) + '）');
  }
}

function requireStringArray(args: unknown[], idx: number, what: string): string[] {
  const v = args[idx];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new PtcContractError(what, '参数 ' + idx + ' 必须是字符串数组');
  }
  return v as string[];
}

/** PTC 能力注册表（单一真相源——能力面/校验/降级/三要素全部由此派生） */
export const PTC_CAPABILITIES: Record<string, PtcCapabilityDef> = {
  // —— 记忆 ——
  'memory.query': {
    name: 'memory.query', family: 'memory',
    params: '(sql: string)',
    returnType: 'Promise<Array<Record<string, unknown>>>',
    anchor: '记忆库只读 SQL（仅 SELECT memory_entries，自动 LIMIT）',
    whenToUse: '查条目 / 统计 / 锚点→原文展开',
    effect: '行数组（id/kind/content/meta…）',
    validate: (args) => { requireString(args, 0, 'memory.query'); },
    asAction: (a) => `return await memory.query(${JSON.stringify(String(a.sql ?? ''))});`,
  },
  'memory.write': {
    name: 'memory.write', family: 'memory',
    params: '(entry: { id?: string; kind?: string; anchors?: string[]; content: string })',
    returnType: 'Promise<void>',
    anchor: '记忆写入（沉淀）',
    whenToUse: '沉淀知识（task-insight / tool-function 等知识层自由写）',
    effect: '条目落库',
    validate: (args) => {
      // 2026-08-15 筛查 M4：双签名（对象形/位置形）在进入 normalizeWriteArgs 前不误拒
      if (typeof args[0] === 'string') {
        requireString(args, 1, 'memory.write');
        return;
      }
      const e = requireObject(args, 0, 'memory.write');
      if (typeof e.content !== 'string' || e.content.trim() === '') {
        throw new PtcContractError('memory.write', 'entry.content 必须是非空字符串');
      }
    },
    asAction: (a) => `return await memory.write(${JSON.stringify(a)});`,
  },
  // —— B4 Phase 3：skill 维护面（仅 memory-keeper 注入）——
  'skills.maintain.write': {
    name: 'skills.maintain.write', family: 'memory',
    params: '(input: { name: string; content: string; anchors?: string[]; force?: boolean; audit?: string; proposalId?: string })',
    returnType: 'Promise<{ ok: boolean; id?: string; error?: string }>',
    anchor: '固化/修订 skill 条目（写后冻结）',
    whenToUse: 'memory-keeper 维护任务：新 SOP 固化，或显式 force 修订已有条目',
    effect: 'skill:<name> 官方条目落库（force 修订带 audit 留痕）',
    validate: (args) => {
      const e = requireObject(args, 0, 'skills.maintain.write');
      if (typeof e.name !== 'string' || e.name.trim() === '') throw new PtcContractError('skills.maintain.write', 'name 必填');
      if (typeof e.content !== 'string' || e.content.trim() === '') throw new PtcContractError('skills.maintain.write', 'content 必填');
    },
    asAction: (a) => `return await skills.maintain.write(${JSON.stringify(a)});`,
  },
  'skills.maintain.archive': {
    name: 'skills.maintain.archive', family: 'memory',
    params: '(id: string, audit?: string)',
    returnType: 'Promise<{ ok: boolean; id?: string; error?: string }>',
    anchor: '归档 skill 条目（修订流的第一半）',
    whenToUse: '旧 SOP 被新条目取代——先 archive 再写新条目',
    effect: '条目 status→archived，保留审计 meta',
    validate: (args) => { requireString(args, 0, 'skills.maintain.archive'); },
    asAction: (a) => `return await skills.maintain.archive(${JSON.stringify(String(a.id ?? ''))}${a.audit !== undefined ? `, ${JSON.stringify(String(a.audit))}` : ''});`,
  },
  // —— LLM ——
  'llm.complete': {
    name: 'llm.complete', family: 'llm',
    params: "(messages: Array<{ role: 'system' | 'user'; content: string }>, opts?)",
    returnType: 'Promise<{ content: string; model: string; usage?: object }>',
    anchor: '嵌套 LLM 调用（子分析/评估/翻译）',
    whenToUse: '二次推理——主循环之外需要独立 LLM 判断时',
    effect: 'LLM 回复（content + usage）',
    validate: (args) => {
      const msgs = args[0];
      if (!Array.isArray(msgs) || msgs.length === 0
        || msgs.some((m) => !m || typeof m !== 'object' || typeof (m as { content?: unknown }).content !== 'string')) {
        throw new PtcContractError('llm.complete', 'messages 必须是非空数组，每项含字符串 content');
      }
    },
    asAction: (a) => `return await llm.complete([{ role: ${JSON.stringify('system')}, content: ${JSON.stringify(String(a.system ?? '你是助手'))} }, { role: ${JSON.stringify('user')}, content: ${JSON.stringify(String(a.user ?? ''))} }]);`,
  },
  // —— Web ——
  'web.fetchText': {
    name: 'web.fetchText', family: 'web',
    params: '(url: string, opts?: { maxBytes?: number; timeoutMs?: number })',
    returnType: 'Promise<string>',
    anchor: '受限只读 HTTP(S) fetch',
    whenToUse: '抓取官方文档/页面文本（联网调研）',
    effect: '纯文本（HTML 剥标签；1MB/30s 上限）',
    validate: (args) => { requireString(args, 0, 'web.fetchText'); },
    asAction: (a) => `return await web.fetchText(${JSON.stringify(String(a.url ?? ''))});`,
  },
  // —— 文件面 ——
  'fs.readText': {
    name: 'fs.readText', family: 'fs',
    params: '(path: string)',
    returnType: 'Promise<string>',
    anchor: 'toolstore 只读文件',
    whenToUse: '读扩展/技能源码',
    effect: '全文',
    validate: (args) => { requireString(args, 0, 'fs.readText'); },
    asAction: (a) => `return await fs.readText(${JSON.stringify(String(a.path ?? ''))});`,
  },
  'fs.list': {
    name: 'fs.list', family: 'fs',
    params: '()',
    returnType: 'Promise<Array<{ name: string; isDir: boolean }>>',
    anchor: 'toolstore 目录枚举',
    whenToUse: '发现可用扩展',
    effect: '目录项数组',
    asAction: () => `return await fs.list();`,
  },
  'fs.readSource': {
    name: 'fs.readSource', family: 'fs',
    params: '(relPath: string)',
    returnType: 'Promise<string>',
    anchor: 'PTH 源码只读（src/ 白名单 + 路径校验）',
    whenToUse: '读框架源码（自修改前理解实现）',
    effect: '全文',
    validate: (args) => { requireString(args, 0, 'fs.readSource'); },
  },
  // —— 环境 ——
  'env.inspect': {
    name: 'env.inspect', family: 'env',
    params: '(lang?: string)',
    returnType: 'Promise<unknown>',
    anchor: '环境状态摘要',
    whenToUse: '确认环境/版本/可用性',
    effect: '状态摘要（变量/函数概览）',
    validate: (args) => { optionalString(args, 0, 'env.inspect'); },
    asAction: (a) => `return await env.inspect(${a.lang ? JSON.stringify(String(a.lang)) : ''});`,
  },
  // —— 召回 ——
  'state.recallFunctions': {
    name: 'state.recallFunctions', family: 'state',
    params: '(anchors: string[], opts?)',
    returnType: 'Promise<Array<{ key: string; source: string; spec: object | null }>>',
    anchor: '召回已沉淀的工具函数',
    whenToUse: '找既有实现复用（先查后写）',
    effect: '函数列表（key + source + spec）',
    validate: (args) => { if (args[0] !== undefined) requireStringArray(args, 0, 'state.recallFunctions'); },
    asAction: (a) => `return await state.recallFunctions(${a.query ? JSON.stringify([String(a.query)]) : '[]'});`,
  },
  'state.recallInsights': {
    name: 'state.recallInsights', family: 'state',
    params: '(anchors: string[], opts?)',
    returnType: 'Promise<string[]>',
    anchor: '召回已沉淀的洞察',
    whenToUse: '查历史经验（避免重蹈覆辙）',
    effect: '洞察文本列表',
    validate: (args) => { if (args[0] !== undefined) requireStringArray(args, 0, 'state.recallInsights'); },
    asAction: (a) => `return await state.recallInsights(${a.query ? JSON.stringify([String(a.query)]) : '[]'});`,
  },
  // —— 任务级对象（元数据——不校验） ——
  'cache': {
    name: 'cache', family: 'cache',
    params: '(get/load/cancel/index/utilization)',
    returnType: 'object',
    anchor: '任务级随身缓存',
    whenToUse: '跨步携带数据（ts 程序间传递）',
    effect: '条目管理 + 利用率统计',
  },
  'skills.get': {
    name: 'skills.get', family: 'ts-local',
    params: '(name: string)',
    returnType: 'Promise<unknown>',
    anchor: 'skill 数据对象读取（v1 占位）',
    whenToUse: '按名取技能包',
    effect: 'skill 对象（v1 返回空）',
  },
  // 核契约条目（2026-08-14 A1 Phase 2 修订）：其他语言两级落位——
  // 程序内调用 = Interpreter 核契约（execute → InterpreterResult），不建 per-language 包装；
  // 单步 LLM 工具 = 动作工具面（bash.run/python.run——Phase 3 工具面生成器投影）。
  'bash': {
    name: 'bash', family: 'kernel',
    params: '（核契约——execute(program: string, opts?: ExecuteOptions)）',
    returnType: 'InterpreterResult { ok, value?, stdout?, stderr?, error?, durationMs, truncated? }',
    anchor: 'bash 核（环境管理——shell 命令）',
    whenToUse: '程序内 shell 命令/环境操作（单步 LLM 工具用 bash.run——工具面投影）',
    effect: 'InterpreterResult——value 为命令输出对象',
    note: 'Phase 3：dispose 终止语义统一落点（程序级制动）',
  },
  'python': {
    name: 'python', family: 'kernel',
    params: '（核契约——execute(program: string, opts?: ExecuteOptions)）',
    returnType: 'InterpreterResult { ok, value?, stdout?, stderr?, error?, durationMs, truncated? }',
    anchor: 'python 核（计算/数据处理）',
    whenToUse: '程序内数值/数据处理（单步 LLM 工具用 python.run——工具面投影）',
    effect: 'InterpreterResult——value 为程序结果',
    note: 'Phase 3：dispose 终止语义统一落点（程序级制动）',
  },
  'results': {
    name: 'results', family: 'seed',
    params: '（预置对象——步骤结果注册表）',
    returnType: 'Record<string, unknown>',
    anchor: 'ts 核内步骤结果注册表',
    whenToUse: '程序引用前序步骤结果（result_N）',
    effect: '按 key 读步骤结果',
  },
  'context': {
    name: 'context', family: 'seed',
    params: '（预置对象——工作台）',
    returnType: 'Record<string, unknown>',
    anchor: 'ts 核内工作台对象',
    whenToUse: '程序间共享中间状态',
    effect: '跨 execute 持久对象',
  },
  // —— A1 遗留补齐：注册表外能力面（prompt-docs 手写散文切换前提）——
  'model': {
    name: 'model', family: 'seed',
    params: '（会话模型状态对象——current/set/usage）',
    returnType: 'object',
    anchor: '会话模型状态',
    whenToUse: '查/切会话模型、查 token 消耗',
    effect: 'model.current / model.set({model}) / model.usage()',
  },
  'perf': {
    name: 'perf', family: 'seed',
    params: '（性能参数与策略对象——params/set/analyze/publish/apply）',
    returnType: 'object',
    anchor: '性能参数与策略',
    whenToUse: '调参/诊断/发布优化策略',
    effect: 'perf.params() / perf.set({key, value}) / perf.analyze() / perf.publish() / perf.apply()',
  },
  'obs': {
    name: 'obs', family: 'seed',
    params: '（系统观测对象——tasks/metrics/batches/kernels/search）',
    returnType: 'object',
    anchor: '系统观测',
    whenToUse: '查任务池/批次/指标/事件',
    effect: 'obs.tasks() / obs.metrics() / obs.batches() / obs.kernels() / obs.search()',
  },
  'fs.task.write': {
    name: 'fs.task.write', family: 'fs',
    params: '(relPath: string, content: string)',
    returnType: 'Promise<{ ok: boolean; path: string; bytes: number }>',
    anchor: '任务工作区写入（防穿越——只写自己目录）',
    whenToUse: '任务产物落盘',
    effect: '文件写入',
  },
  'fs.task.read': {
    name: 'fs.task.read', family: 'fs',
    params: '(relPath: string)',
    returnType: 'Promise<string>',
    anchor: '任务工作区读取',
    whenToUse: '回读自己的产物',
    effect: '全文',
  },
  'fs.task.list': {
    name: 'fs.task.list', family: 'fs',
    params: '()',
    returnType: 'Promise<Array<{ name: string; isDir: boolean }>>',
    anchor: '任务工作区枚举',
    whenToUse: '清点产物',
    effect: '文件清单',
  },
  'tasks.delegate': {
    name: 'tasks.delegate', family: 'tasks',
    params: '(input: { to: string; title: string; text: string; template?: string; params?: object; tags?: string[]; context?: object; expect?: "result"|"artifact"|"report" })',
    returnType: 'Promise<{ taskId: string; roleId: string; path: string[] }>',
    anchor: '父 worker 向直接子类型投递任务（0.16.4 投递原语）',
    whenToUse: '把自包含子任务派发给直接子类型并立即拿回 taskId',
    effect: '异步投递——服务端按调用者身份盖章 parent/path/lineageId，组织权违规调用即拒绝',
    validate: (args) => {
      const e = requireObject(args, 0, 'tasks.delegate');
      if (typeof e.to !== 'string' || e.to.trim() === '') throw new PtcContractError('tasks.delegate', 'to 必须是非空字符串');
      if (typeof e.title !== 'string' || e.title.trim() === '') throw new PtcContractError('tasks.delegate', 'title 必须是非空字符串');
      if (typeof e.text !== 'string' || e.text.trim() === '') throw new PtcContractError('tasks.delegate', 'text 必须是非空字符串');
      if (e.template !== undefined && typeof e.template !== 'string') throw new PtcContractError('tasks.delegate', 'template 可选——若提供必须是字符串');
      if (e.expect !== undefined && !['result', 'artifact', 'report'].includes(String(e.expect))) {
        throw new PtcContractError('tasks.delegate', 'expect 仅支持 result/artifact/report');
      }
    },
    asAction: (a) => `return await tasks.delegate(${JSON.stringify(a)});`,
  },
  'tasks.await': {
    name: 'tasks.await', family: 'tasks',
    params: '(input: { taskId: string; timeoutMs?: number; detach?: boolean })',
    returnType: 'Promise<{ status: string; waiting?: boolean; result?: unknown; artifactRef?: {kind:string;id:string}|null; summary?: string; error?: {code:string;message:string} }>',
    anchor: '父 worker 回收直接子任务结果（P1=一次性状态查询；P2=事件驱动挂起 + requeue）',
    whenToUse: 'delegate 之后取子任务终态/结果/产物引用',
    effect: '只读本任务直接子任务（delivery.parent 校验）——不轮询不挂起（P1 契约形态）',
    validate: (args) => {
      const e = requireObject(args, 0, 'tasks.await');
      if (typeof e.taskId !== 'string' || e.taskId.trim() === '') throw new PtcContractError('tasks.await', 'taskId 必须是非空字符串');
      if (e.timeoutMs !== undefined && (typeof e.timeoutMs !== 'number' || !Number.isFinite(e.timeoutMs) || e.timeoutMs < 0)) {
        throw new PtcContractError('tasks.await', 'timeoutMs 必须是非负有限数字');
      }
    },
    asAction: (a) => `return await tasks.await(${JSON.stringify(a)});`,
  },
  'tasks.resume': {
    name: 'tasks.resume', family: 'tasks',
    params: '()',
    returnType: 'Promise<{ waiting: Record<string,{at:string}>; results: Record<string, TaskAwaitResult> }>',
    anchor: '父任务挂起重跑后的续接点（W8 P2 事件驱动回流）',
    whenToUse: '任务程序开头读取已回流的 childResult 与等待登记，避免重复 delegate',
    effect: '只读本任务 payload.dispatchWait/childResult 快照（task-loop 盖章——不可伪造）',
    asAction: () => 'return await tasks.resume();',
  },
  'tasks.penetrate': {
    name: 'tasks.penetrate', family: 'tasks',
    params: '(input: { to: string; title: string; text: string; context?: object })',
    returnType: 'Promise<{ ok: true; value: unknown; summary?: string; steps: number; childRole: string; durationMs: number }>',
    anchor: '穿透调用：父 worker 任务内直呼子 agent（0.16.3 固化捷径边——跳过任务池往返）',
    whenToUse: '已注册 skill:penetrate:<child>（official）的稳定路径——同步拿回子 agent done.result',
    effect: '嵌套子 agent 执行（深度限 1——子 agent 内不可再穿透）；未注册/draft/边归属不符/组织权违规调用即拒绝；执行失败报错由父决策',
    validate: (args) => {
      const e = requireObject(args, 0, 'tasks.penetrate');
      if (typeof e.to !== 'string' || e.to.trim() === '') throw new PtcContractError('tasks.penetrate', 'to 必须是非空字符串');
      if (typeof e.title !== 'string' || e.title.trim() === '') throw new PtcContractError('tasks.penetrate', 'title 必须是非空字符串');
      if (typeof e.text !== 'string' || e.text.trim() === '') throw new PtcContractError('tasks.penetrate', 'text 必须是非空字符串');
    },
    asAction: (a) => `return await tasks.penetrate(${JSON.stringify(a)});`,
  },
  'ext': {
    name: 'ext', family: 'ts-local',
    params: '（扩展编排对象——index/use/kernel/syncIndex）',
    returnType: 'object',
    anchor: '代码库式扩展编排',
    whenToUse: 'index/use/kernel/syncIndex 操作已装载扩展',
    effect: '扩展能力注入',
  },
  'python.run': {
    name: 'python.run', family: 'kernel', host: 'kernel-ts',
    params: '(input: { code: string; mode?: string })',
    returnType: 'Promise<InterpreterResult>',
    anchor: "python 程序——python 生态/数据计算的多语句执行",
    whenToUse: "需要 python 库、多语句/循环、_result 值回传；ts 能做的用 ts（ts 程序内可 await python 能力）",
    effect: "多语句执行，_result 值回传",
    toolSchema: { properties: {
      "code": {
        "type": "string",
        "description": "python 程序（多语句；_result = 值 作为结果）"
      },
      "mode": {
        "type": "string",
        "enum": [
          "default",
          "value-only",
          "errors-only",
          "quiet"
        ]
      }
    }, required: ["code"] },
  },
  'python.eval': {
    name: 'python.eval', family: 'kernel', host: 'kernel-ts',
    params: '(input: { code: string; mode?: string })',
    returnType: 'Promise<InterpreterResult>',
    anchor: "python 单表达式——一行计算/查询",
    whenToUse: "单表达式求值；多语句用 python.run",
    effect: "表达式值即结果",
    toolSchema: { properties: {
      "code": {
        "type": "string",
        "description": "python 表达式（值即结果）"
      },
      "mode": {
        "type": "string",
        "enum": [
          "default",
          "value-only",
          "errors-only",
          "quiet"
        ]
      }
    }, required: ["code"] },
  },
  'bash.run': {
    name: 'bash.run', family: 'kernel', host: 'kernel-ts',
    params: '(input: { command: string; mode?: string })',
    returnType: 'Promise<InterpreterResult>',
    anchor: "bash 命令序列——环境操作/文件检查/管道",
    whenToUse: "多命令串联的环境操作与探测；产物写入不走 bash（走 dev.write/write.create）",
    effect: "stdout 即结果（截断 4000 字符）",
    toolSchema: { properties: {
      "command": {
        "type": "string",
        "description": "shell 命令（可多命令串联）"
      },
      "mode": {
        "type": "string",
        "enum": [
          "default",
          "value-only",
          "errors-only",
          "quiet"
        ]
      }
    }, required: ["command"] },
  },
  'bash.eval': {
    name: 'bash.eval', family: 'kernel', host: 'kernel-ts',
    params: '(input: { command: string; mode?: string })',
    returnType: 'Promise<InterpreterResult>',
    anchor: "bash 单命令——ls/cat/grep 等简单探测",
    whenToUse: "单条命令快速查询；复杂脚本用 bash.run",
    effect: "stdout 即结果",
    toolSchema: { properties: {
      "command": {
        "type": "string",
        "description": "单条 shell 命令"
      },
      "mode": {
        "type": "string",
        "enum": [
          "default",
          "value-only",
          "errors-only",
          "quiet"
        ]
      }
    }, required: ["command"] },
  },
  'ts.run': {
    name: 'ts.run', family: 'ts-local', host: 'kernel-ts',
    params: '(input: { code: string; mode?: string })',
    returnType: 'Promise<InterpreterResult>',
    anchor: "ts 程序（程序模式——优先）——一个程序组合多能力",
    whenToUse: "多步操作/变量/循环/组合能力函数（memory/llm/web/fs/python/bash）——优先写一个程序而非分步发多个动作；大内容一次取回后在程序内本地处理（切片/过滤/聚合），不重复分片读取",
    effect: "return 值回填 + stdout 可见",
    toolSchema: { properties: {
      "code": {
        "type": "string",
        "description": "ts 程序（顶层 await 可用；声明/多语句/控制流；return 对象作为结果）"
      },
      "mode": {
        "type": "string",
        "enum": [
          "default",
          "value-only",
          "errors-only",
          "quiet"
        ]
      }
    }, required: ["code"] },
  },
  'ts.eval': {
    name: 'ts.eval', family: 'ts-local', host: 'kernel-ts',
    params: '(input: { code: string; mode?: string })',
    returnType: 'Promise<InterpreterResult>',
    anchor: "ts 单表达式——一行查询/计算",
    whenToUse: "无变量无循环的单表达式（await memory.query 计数等）；多步骤用 ts.run",
    effect: "表达式值即结果",
    toolSchema: { properties: {
      "code": {
        "type": "string",
        "description": "ts 单表达式（顶层 await 可用；表达式的值即结果）"
      },
      "mode": {
        "type": "string",
        "enum": [
          "default",
          "value-only",
          "errors-only",
          "quiet"
        ]
      }
    }, required: ["code"] },
  },
  'done': {
    name: 'done', family: 'loop', host: 'loop',
    params: '(input: { result: unknown; summary?: string })',
    returnType: 'Promise<{ ok: true }>',
    anchor: "任务完成——提交最终产出",
    whenToUse: "有实际产物（实现/文件/计算结果）或明确无法完成（说明原因）时",
    effect: "任务结案；result 为空会被拒绝并回填引导（ASP：仅元空间可用）",
    toolSchema: { properties: {
      "result": {
        "description": "最终产出对象（任意 JSON）——必填；须为实际产物（实现代码/写入的文件/计算结果），不能为空对象/空数组/空字符串"
      },
      "summary": {
        "type": "string",
        "description": "完成说明"
      }
    }, required: ["result"] },
  },
  'pause': {
    name: 'pause', family: 'loop', host: 'loop',
    params: '(input: { question: string; context?: unknown })',
    returnType: 'Promise<{ ok: true }>',
    anchor: "向发布者提问——任务暂停等待澄清",
    whenToUse: "规约/目标歧义、缺少关键信息、继续执行可能跑偏时",
    effect: "任务进入 paused 状态，问题写入待回答问题箱；发布者回答后任务重跑并注入澄清",
    toolSchema: { properties: {
      "question": {
        "type": "string",
        "description": "向发布者提出的问题（必填，非空）"
      },
      "context": {
        "type": "object",
        "description": "可选上下文快照（帮助发布者定位）"
      }
    }, required: ["question"] },
  },
  'dev.write': {
    name: 'dev.write', family: 'dev', host: 'kernel-ts',
    params: '(input: { path: string; code: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: { path: string }; stdout: string }>',
    anchor: "写代码——实现第一步",
    whenToUse: "把完整实现一次写完（自动建目录），不要写几行跑一次的小步迭代",
    effect: "源码落任务工作区，可 build/run 验证",
    toolSchema: { properties: {
      "path": {
        "type": "string",
        "description": "工作区相对路径（如 main.c）"
      },
      "code": {
        "type": "string",
        "description": "完整源码"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["path", "code"] },
    asAction: (a) => `return await dev.write(${JSON.stringify(a)});`,
  },
  'dev.edit': {
    name: 'dev.edit', family: 'dev', host: 'kernel-ts',
    params: '(input: { path: string; oldText: string; newText: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: { path: string }; stdout: string }>',
    anchor: "改代码——编译/运行报错后精修",
    whenToUse: "唯一匹配替换（oldText 不匹配/多处匹配报错）；整段替换优先于零敲碎打",
    effect: "文件中该段被替换",
    toolSchema: { properties: {
      "path": {
        "type": "string"
      },
      "oldText": {
        "type": "string"
      },
      "newText": {
        "type": "string"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["path", "oldText", "newText"] },
    asAction: (a) => `return await dev.edit(${JSON.stringify(a)});`,
  },
  'dev.build': {
    name: 'dev.build', family: 'dev', host: 'kernel-ts',
    params: '(input: { path: string; cc?: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value?: unknown; stdout: string }>',
    anchor: "编译验证——写完代码检查语法",
    whenToUse: "只查语法不运行；直接要结果用 dev.run",
    effect: "编译产物（错误回填）",
    toolSchema: { properties: {
      "path": {
        "type": "string"
      },
      "cc": {
        "type": "string"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["path"] },
    asAction: (a) => `return await dev.build(${JSON.stringify(a)});`,
  },
  'dev.run': {
    name: 'dev.run', family: 'dev', host: 'kernel-ts',
    params: '(input: { path: string; cc?: string; timeoutMs?: number; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value?: unknown; stdout: string }>',
    anchor: "运行验证——编译+运行一步",
    whenToUse: "写完代码直接拿结果；编译错误回填后 dev.edit 修，不重写整文件",
    effect: "运行结果（源码不变秒回缓存）",
    toolSchema: { properties: {
      "path": {
        "type": "string"
      },
      "cc": {
        "type": "string"
      },
      "timeoutMs": {
        "type": "number"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["path"] },
    asAction: (a) => `return await dev.run(${JSON.stringify(a)});`,
  },
  'dev.save': {
    name: 'dev.save', family: 'dev', host: 'kernel-ts',
    params: '(input: { name: string; path: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: { name: string }; stdout: string }>',
    anchor: "交付保存——验证通过后",
    whenToUse: "保存为命名编译单元供跨任务复用；验证通过后再 save",
    effect: "toolstore compiled-units/<name>.c",
    toolSchema: { properties: {
      "name": {
        "type": "string"
      },
      "path": {
        "type": "string"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["name", "path"] },
    asAction: (a) => `return await dev.save(${JSON.stringify(a)});`,
  },
  'dev.list': {
    name: 'dev.list', family: 'dev', host: 'kernel-ts',
    params: '(input?: { mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: string[]; stdout: string }>',
    anchor: "查看已有编译单元——实现前先查复用",
    whenToUse: "新任务先 list——复用优于重写",
    effect: "已保存编译单元清单",
    toolSchema: { properties: {
      "mode": {
        "type": "string"
      }
    }, required: [] },
    asAction: (a) => `return await dev.list(${JSON.stringify(a)});`,
  },
  'debug.attach': {
    name: 'debug.attach', family: 'debug', host: 'sandbox-debug',
    params: '(input: { code?: string; path?: string; cc?: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: { sessionId: string }; stdout: string }>',
    anchor: "调试第一步——dev.run 异常/崩溃时",
    whenToUse: "正常流程不需要调试，仅结果异常时",
    effect: "C 调试会话，返回 sessionId 句柄",
    toolSchema: { properties: {
      "code": {
        "type": "string"
      },
      "path": {
        "type": "string"
      },
      "cc": {
        "type": "string"
      },
      "mode": {
        "type": "string"
      }
    }, required: [] },
    asAction: (a) => `return await debug.attach(${JSON.stringify(a)});`,
  },
  'debug.breakpoint': {
    name: 'debug.breakpoint', family: 'debug', host: 'sandbox-debug',
    params: '(input: { sessionId: string; line: number; condition?: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: unknown; stdout: string }>',
    anchor: "设断点——attach 后",
    whenToUse: "指定行停住（line 行号，condition 可选）",
    effect: "断点注册，命中时暂停",
    toolSchema: { properties: {
      "sessionId": {
        "type": "string"
      },
      "line": {
        "type": "number"
      },
      "condition": {
        "type": "string"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["sessionId", "line"] },
    asAction: (a) => `return await debug.breakpoint(${JSON.stringify(a)});`,
  },
  'debug.continue': {
    name: 'debug.continue', family: 'debug', host: 'sandbox-debug',
    params: '(input: { sessionId: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value?: unknown; stdout: string }>',
    anchor: "继续执行——设好断点后",
    whenToUse: "跑到断点/退出",
    effect: "返回 reason + frame",
    toolSchema: { properties: {
      "sessionId": {
        "type": "string"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["sessionId"] },
    asAction: (a) => `return await debug.continue(${JSON.stringify(a)});`,
  },
  'debug.step': {
    name: 'debug.step', family: 'debug', host: 'sandbox-debug',
    params: '(input: { sessionId: string; direction: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value?: unknown; stdout: string }>',
    anchor: "单步——定位具体行",
    whenToUse: "direction into/over/out 逐行推进",
    effect: "执行一步并停住",
    toolSchema: { properties: {
      "sessionId": {
        "type": "string"
      },
      "direction": {
        "type": "string"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["sessionId", "direction"] },
    asAction: (a) => `return await debug.step(${JSON.stringify(a)});`,
  },
  'debug.snapshot': {
    name: 'debug.snapshot', family: 'debug', host: 'sandbox-debug',
    params: '(input: { sessionId: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: unknown; stdout: string }>',
    anchor: "变量全览——停住后首选",
    whenToUse: "断点命中后先 snapshot 再决定 evaluate 什么",
    effect: "全帧+顶层帧变量聚合快照",
    toolSchema: { properties: {
      "sessionId": {
        "type": "string"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["sessionId"] },
    asAction: (a) => `return await debug.snapshot(${JSON.stringify(a)});`,
  },
  'debug.evaluate': {
    name: 'debug.evaluate', family: 'debug', host: 'sandbox-debug',
    params: '(input: { sessionId: string; expr: string; frameId?: number; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: unknown; stdout: string }>',
    anchor: "表达式求值——snapshot 后验证假设",
    whenToUse: "对具体变量/表达式求值",
    effect: "当前暂停位置上下文中的求值结果",
    toolSchema: { properties: {
      "sessionId": {
        "type": "string"
      },
      "expr": {
        "type": "string"
      },
      "frameId": {
        "type": "number"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["sessionId", "expr"] },
    asAction: (a) => `return await debug.evaluate(${JSON.stringify(a)});`,
  },
  'debug.detach': {
    name: 'debug.detach', family: 'debug', host: 'sandbox-debug',
    params: '(input: { sessionId: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; stdout: string }>',
    anchor: "释放会话——调完必调",
    whenToUse: "排查结束立即归还句柄（上限 4 个）",
    effect: "会话销毁",
    toolSchema: { properties: {
      "sessionId": {
        "type": "string"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["sessionId"] },
    asAction: (a) => `return await debug.detach(${JSON.stringify(a)});`,
  },
  'debug.sessions': {
    name: 'debug.sessions', family: 'debug', host: 'sandbox-debug',
    params: '(input?: { mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: unknown; stdout: string }>',
    anchor: "查看活动会话",
    whenToUse: "需要确认存活会话",
    effect: "活动调试会话清单",
    toolSchema: { properties: {
      "mode": {
        "type": "string"
      }
    }, required: [] },
    asAction: (a) => `return await debug.sessions(${JSON.stringify(a)});`,
  },
  'write.create': {
    name: 'write.create', family: 'write', host: 'kernel-ts',
    params: '(input: { path: string; content: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: { path: string }; stdout: string }>',
    anchor: "写文档——初稿一次写完",
    whenToUse: "创建新文档；一次写完再 edit 修订，不要分段多次 create",
    effect: "工作区文档落盘",
    toolSchema: { properties: {
      "path": {
        "type": "string"
      },
      "content": {
        "type": "string"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["path", "content"] },
    asAction: (a) => `return await write.create(${JSON.stringify(a)});`,
  },
  'write.edit': {
    name: 'write.edit', family: 'write', host: 'kernel-ts',
    params: '(input: { path: string; oldText: string; newText: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: { path: string }; stdout: string }>',
    anchor: "修订文档——改具体段落",
    whenToUse: "唯一匹配替换（oldText 必须唯一）",
    effect: "该段被替换",
    toolSchema: { properties: {
      "path": {
        "type": "string"
      },
      "oldText": {
        "type": "string"
      },
      "newText": {
        "type": "string"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["path", "oldText", "newText"] },
    asAction: (a) => `return await write.edit(${JSON.stringify(a)});`,
  },
  'write.read': {
    name: 'write.read', family: 'write', host: 'kernel-ts',
    params: '(input: { path: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: { path: string; length: number; truncated: boolean }; stdout: string }>',
    anchor: "读文档——验证/续写前",
    whenToUse: "读全文（截断 6000 字符，长文档分段）",
    effect: "文档内容回传",
    toolSchema: { properties: {
      "path": {
        "type": "string"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["path"] },
    asAction: (a) => `return await write.read(${JSON.stringify(a)});`,
  },
  'write.list': {
    name: 'write.list', family: 'write', host: 'kernel-ts',
    params: '(input?: { mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: string[]; stdout: string }>',
    anchor: "看工作区已有文档——避免重复创建",
    whenToUse: "动笔前先查",
    effect: "工作区文档清单（*.md/txt/rst/adoc 递归）",
    toolSchema: { properties: {
      "mode": {
        "type": "string"
      }
    }, required: [] },
    asAction: (a) => `return await write.list(${JSON.stringify(a)});`,
  },
  'write.save': {
    name: 'write.save', family: 'write', host: 'kernel-ts',
    params: '(input: { path: string; name: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: { name: string }; stdout: string }>',
    anchor: "定稿保存——跨任务复用",
    whenToUse: "文档定稿后存记忆单元",
    effect: "docs/<name>.md 记忆条目",
    toolSchema: { properties: {
      "path": {
        "type": "string"
      },
      "name": {
        "type": "string"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["path", "name"] },
    asAction: (a) => `return await write.save(${JSON.stringify(a)});`,
  },
  'write.section': {
    name: 'write.section', family: 'write', host: 'kernel-ts',
    params: '(input: { path: string; op: string; title?: string; target?: string; before?: string; mode?: string })',
    returnType: 'Promise<{ ok: boolean; value: unknown; stdout: string }>',
    anchor: "长文档结构整理——章节拆合",
    whenToUse: "op=list/split/reorder；短文档不需要",
    effect: "章节结构调整",
    toolSchema: { properties: {
      "path": {
        "type": "string"
      },
      "op": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "target": {
        "type": "string"
      },
      "before": {
        "type": "string"
      },
      "mode": {
        "type": "string"
      }
    }, required: ["path"] },
    asAction: (a) => `return await write.section(${JSON.stringify(a)});`,
  },
  'asp.cd': {
    name: 'asp.cd', family: 'loop', host: 'loop',
    params: '(input: { space: string })',
    returnType: 'Promise<{ ok: boolean; stdout: string }>',
    anchor: "空间切换——我的可达空间内切换注意力",
    whenToUse: "语言代码须在对应空间执行；done 仅元空间可用；绑定空间仅绑定 worker 类型可进入（语言执行基板全角色共享）",
    effect: "切换当前空间（工具面/记忆域随之切换——注意力重置）",
    toolSchema: { properties: {
      "space": {
        "type": "string",
        "description": "目标空间 id（meta/ts/python/bash/dev/write 基板或本角色绑定空间）"
      }
    }, required: ["space"] },
  },
  'asp.index': {
    name: 'asp.index', family: 'loop', host: 'loop',
    params: '(input?: { mode?: string; space?: string })',
    returnType: 'Promise<{ ok: boolean; stdout: string }>',
    anchor: "空间地图——我的可达空间",
    whenToUse: "新任务/切空间前先看——本角色可进入的空间（基板 + 我的绑定空间）与生成状态；避免盲目 asp_cd 往返",
    effect: "空间树 + 当前空间可达函数与数据",
    toolSchema: { properties: {
      "mode": {
        "type": "string",
        "enum": [
          "by-package",
          "by-type"
        ],
        "description": "聚合模式（缺省 by-package）"
      },
      "space": {
        "type": "string",
        "description": "目标空间 id（缺省当前空间）"
      }
    }, required: [] },
  },
  'memory.index': {
    name: 'memory.index', family: 'loop', host: 'loop',
    params: '(input?: { tag?: string; id?: string })',
    returnType: 'Promise<{ ok: boolean; stdout: string }>',
    anchor: "记忆库地图——查询/统计第一步必用",
    whenToUse: "避免逐条 SQL 盲查；统计任务一次就够，不要每步重复索引",
    effect: "顶层视图（kind 分布+热门 tag）/ tag 清单 / id 摘要+出边",
    toolSchema: { properties: {
      "tag": {
        "type": "string",
        "description": "按 tag 查关联条目"
      },
      "id": {
        "type": "string",
        "description": "按条目 id 查其 tag 出边"
      }
    }, required: [] },
  },
  'cache.load': {
    name: 'cache.load', family: 'loop', host: 'loop',
    params: '(input: { id?: string; ids?: string[]; tag?: string; key?: string; content?: string })',
    returnType: 'Promise<{ ok: boolean; stdout: string }>',
    anchor: "跨空间携带数据——离开空间前先存",
    whenToUse: "后续步骤要反复取用的数据先载入（任何空间可引用）；来源 id/ids/tag 或 key+content",
    effect: "条目入随身缓存（硬容量限制，超容拒绝需先 cancel）",
    toolSchema: { properties: {
      "id": {
        "type": "string",
        "description": "记忆条目 id"
      },
      "ids": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "批量条目 id"
      },
      "tag": {
        "type": "string",
        "description": "按 tag 批量载入"
      },
      "key": {
        "type": "string",
        "description": "自定义键（配合 content）"
      },
      "content": {
        "type": "string",
        "description": "自定义内容（配合 key）"
      }
    }, required: [] },
  },
  'cache.index': {
    name: 'cache.index', family: 'loop', host: 'loop',
    params: '(input?: Record<string, never>)',
    returnType: 'Promise<{ ok: boolean; stdout: string }>',
    anchor: "查看随身缓存",
    whenToUse: "确认缓存内容/占用/利用率",
    effect: "条目键/大小/剩余容量/利用率一览",
    toolSchema: { properties: {}, required: [] },
  },
  'cache.cancel': {
    name: 'cache.cancel', family: 'loop', host: 'loop',
    params: '(input: { key: string })',
    returnType: 'Promise<{ ok: boolean; stdout: string }>',
    anchor: "缓存释放",
    whenToUse: "腾位给更有价值的信息",
    effect: "条目移除",
    toolSchema: { properties: {
      "key": {
        "type": "string",
        "description": "要释放的缓存键"
      }
    }, required: ["key"] },
  },
};

/** 校验包装：注册表有 validate 的能力函数 → 调用前参数校验（结构化错误）。
 *  泛型保函数签名——原类型透传；校验在调用点同步抛出（fn 执行前）。 */
export function wrapValidated<F extends (...args: never[]) => unknown>(name: string, fn: F): F {
  const def = PTC_CAPABILITIES[name];
  if (!def || !def.validate || !fn) return fn;
  return ((...args: unknown[]) => {
    def.validate!(args);
    return (fn as unknown as (...a: unknown[]) => unknown)(...args);
  }) as unknown as F;
}

/** 能力降级模板映射（parse-agent-action 消费——单一真相源派生） */
export function buildCapabilityAsActionMap(): Record<string, (args: Record<string, unknown>) => string> {
  const map: Record<string, (args: Record<string, unknown>) => string> = {};
  for (const [name, def] of Object.entries(PTC_CAPABILITIES)) {
    if (def.asAction) map[name] = def.asAction;
  }
  return map;
}

