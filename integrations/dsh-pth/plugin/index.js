// PTH interface 模式插件
// ======================
// 这是 dsh（DeepSeek Harness）的一个 Cordis 插件：
// - 只向 agent 注册 pth_* 系列工具（PTH 任务池管理系统的 HTTP 前端）；
// - 通过 systemPrompt 注入一份精简版「PTH 使用手册」；
// - 不注册 bash/fs/subagent 等任何其他模型面工具。
//
// 设计目标：让一个 dsh agent 成为 PTH 系统的“前端操作员”，
// 而不是拥有通用文件/命令执行能力的编码 agent。

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "pth-interface";
export const inject = ["tools", "systemPrompt"];

// 插件配置。tokenEnv 只读环境变量名，绝不把密钥写进仓库。
export const Config = z.object({
  baseUrl: z.string().default("http://localhost:3000"),
  tokenEnv: z.string().default("PTH_TOKEN"),
  waitPollMs: z.number().step(1).min(100).default(1000),
  waitTimeoutSec: z.number().step(1).min(1).default(300),
  maxWaitTimeoutSec: z.number().step(1).min(1).default(3600),
  requestTimeoutMs: z.number().step(1).min(1000).default(15000),
});

// PTH 任务生命周期中的“终态”。wait 会一直轮询到这些状态之一。
const TERMINAL_STATUSES = new Set(["completed", "rejected", "escalated"]);

// 统一的失败返回结构：所有 pth_* 工具失败时都返回 { ok:false, error:{...} }。
function fail(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 拼 URL，query 里 undefined/null/空字符串会被忽略。
function buildUrl(baseUrl, path, query) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(path, normalizedBase);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

// 统一 HTTP 调用：从 process.env[config.tokenEnv] 读取 bearer token，
// 成功返回 { ok:true, data }，失败返回统一错误对象。
async function pthRequest(config, { path, method = "GET", query, body }) {
  const token = process.env[config.tokenEnv];
  if (!token || token.trim() === "") {
    return fail(
      "PTH_TOKEN_MISSING",
      `环境变量 ${config.tokenEnv} 未设置或为空；请先 export ${config.tokenEnv}=<PTH API token> 再运行。`
    );
  }

  let res;
  try {
    res = await fetch(buildUrl(config.baseUrl, path, query), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (err) {
    return fail(
      "PTH_NETWORK_ERROR",
      `无法连接 PTH API（${config.baseUrl}）：${err instanceof Error ? err.message : String(err)}`
    );
  }

  const raw = await res.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
  }

  if (!res.ok) {
    const message = data && typeof data === "object" && "error" in data
      ? String(data.error)
      : `HTTP ${res.status} ${res.statusText}`;
    return fail("PTH_HTTP_ERROR", message, { status: res.status, details: data });
  }

  return { ok: true, data: data ?? {} };
}

// 所有工具默认用 JSON 文本渲染，返回结构在工具 description 中写清楚。
// 注意 dsh-tools 会以 (args, value) 调用 render，因此这里必须保留第二个形参。
function renderJson(_args, value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

// 通用输出 schema：外层统一是 { ok, error?, ...业务字段 }。
const COMMON_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    ok: { type: "boolean", required: true },
    error: { type: "object", additionalProperties: true },
  },
};

export function apply(ctx, config) {
  if (config.waitTimeoutSec > config.maxWaitTimeoutSec) {
    throw new Error(
      `pth-interface: waitTimeoutSec (${config.waitTimeoutSec}) 不能超过 maxWaitTimeoutSec (${config.maxWaitTimeoutSec})`
    );
  }

  // 注入精简版 PTH 使用手册。工具 description 已覆盖每个工具的细节，
  // 这里负责给模型“世界观 + 典型配方 + 纪律”。
  ctx.systemPrompt.section({
    name: "pth:manual",
    order: 200,
    text: `# PTH 任务池管理系统 —— 使用手册（精简版）

## 世界观
- PTH 是一个异步任务池：外部把任务发布到任务池，后台 batch/worker 按角色认领并执行。
- 角色标签路由：任务通过 tags 命中角色。tags 必须已经注册，否则发布会 400。
  常用映射（完整表用 pth_roles() 查）：
  - developer ← code / implement / fix
  - coder ← coding / write-code / snippet
  - tester ← test / qa / verify-func
  - analyst ← analysis / research / deep-analysis
- worker 执行完成时会提交一个 JSON 结果（steps/value/summary），保存在任务 payload.result 与 outputRef.ref 中。
- 你只持有 pth_* 工具：发任务、看状态、等结果、取消、查角色/worker/轨迹。没有 bash/fs/subagent 等工具。

## 典型配方
1. 发任务 → 等待 → 读结果：
   - pth_submit(title, text, tags?) 拿到 taskId；
   - pth_wait(taskId) 轮询到终态（completed/rejected/escalated）；
   - 结果读取 task.payload.result.value / task.outputRef.ref.value；summary 是执行摘要。
2. 排查异常：
   - pth_kernel_status() 看 batch/task 全景；
   - pth_tasks(limit?, status?) 看任务列表；
   - pth_worker_activity(role, sinceSec?) 看某角色在飞/历史；
   - pth_worker_context(role, last?) 看在飞上下文；
   - pth_transcript(taskId) 看轨迹事件与记分卡。
3. 取消不再需要的任务：pth_cancel(taskId)。

## 纪律
- 任务文本必须自包含：把背景、约束、验收标准、期望 JSON 字段全部写进 text，不要依赖工作区文件。
- 要求 worker 最终提交 JSON 对象时，在 text 里明确给出字段形状，例如：最终结果以 JSON 对象提交：{"answer": 数值}。
- 发布前若不确定 tags，先 pth_roles() 查注册角色与标签；不要发明未注册标签。
- 不要尝试用 pth_* 以外的任何工具（本 profile 也已禁用它们）；不要臆造 API 路径或字段。`,
  });

  // pth_submit：发布任务
  ctx.tools.register(defineTool({
    name: "pth_submit",
    description: `向 PTH 任务池发布一个任务。返回 { ok:true, task }，task.id 是后续 pth_wait/pth_status/pth_cancel 用的任务 ID；失败返回 { ok:false, error }。text 必须自包含且包含验收标准；tags 必须是 pth_roles() 中已注册的标签（不传时系统按角色默认路由）。`,
    parameters: {
      title: {
        type: "string",
        required: true,
        description: "任务标题，≤200 字符，应能概括任务。",
      },
      text: {
        type: "string",
        required: true,
        description: "任务正文，≤64KB。必须自包含：背景、约束、验收标准、期望 JSON 字段形状都写在这里。",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "已注册的角色标签数组，例如 [\"coding\"] 或 [\"analysis\"]；不确定时先 pth_roles() 查询。",
      },
    },
    output: {
      schema: COMMON_OUTPUT_SCHEMA,
      render: renderJson,
    },
    async execute(args) {
      const body = { title: args.title, text: args.text };
      if (Array.isArray(args.tags)) body.tags = args.tags;
      const res = await pthRequest(config, { path: "/api/v1/kernel/tasks", method: "POST", body });
      if (!res.ok) return res;
      return { ok: true, task: res.data };
    },
  }));

  // pth_status：查询单个任务
  ctx.tools.register(defineTool({
    name: "pth_status",
    description: `查询单个 PTH 任务详情。返回 { ok:true, task }；task.status 是 pending/claimed/completed/rejected 等；已完成任务的结果在 task.payload.result 与 task.outputRef.ref。失败返回 { ok:false, error }。`,
    parameters: {
      taskId: {
        type: "string",
        required: true,
        description: "pth_submit 返回的任务 ID。",
      },
    },
    output: {
      schema: COMMON_OUTPUT_SCHEMA,
      render: renderJson,
    },
    async execute(args) {
      const res = await pthRequest(config, {
        path: `/api/v1/kernel/tasks/${encodeURIComponent(args.taskId)}`,
      });
      if (!res.ok) return res;
      return { ok: true, task: res.data };
    },
  }));

  // pth_wait：轮询等待任务终态
  ctx.tools.register(defineTool({
    name: "pth_wait",
    description: `轮询等待 PTH 任务进入终态（completed/rejected/escalated）。返回 { ok:true, task, waitedMs, timedOut }；timedOut=true 表示到达 timeoutSec 仍未终态，task 是最近一次快照。失败返回 { ok:false, error }。`,
    parameters: {
      taskId: {
        type: "string",
        required: true,
        description: "pth_submit 返回的任务 ID。",
      },
      timeoutSec: {
        type: "number",
        description: "可选等待秒数；不传用 profile 配置 waitTimeoutSec，且不会超过 maxWaitTimeoutSec。",
      },
    },
    output: {
      schema: COMMON_OUTPUT_SCHEMA,
      render: renderJson,
    },
    async execute(args) {
      const timeoutSec = Math.min(
        Math.max(Math.floor(args.timeoutSec ?? config.waitTimeoutSec), 1),
        config.maxWaitTimeoutSec
      );
      const startedAt = Date.now();
      const deadline = startedAt + timeoutSec * 1000;

      for (;;) {
        const res = await pthRequest(config, {
          path: `/api/v1/kernel/tasks/${encodeURIComponent(args.taskId)}`,
        });
        if (!res.ok) return res;

        const task = res.data;
        if (TERMINAL_STATUSES.has(task?.status)) {
          return { ok: true, task, waitedMs: Date.now() - startedAt, timedOut: false };
        }
        if (Date.now() >= deadline) {
          return { ok: true, task, waitedMs: Date.now() - startedAt, timedOut: true };
        }
        await sleep(config.waitPollMs);
      }
    },
  }));

  // pth_tasks：任务列表
  ctx.tools.register(defineTool({
    name: "pth_tasks",
    description: `查询 PTH 任务列表（按创建时间倒序）。返回 { ok:true, tasks:[...], count }；可用 status 过滤。失败返回 { ok:false, error }。`,
    parameters: {
      limit: {
        type: "number",
        description: "返回条数，1-200，默认 50。",
      },
      status: {
        type: "string",
        description: "可选状态过滤，例如 pending/claimed/completed/rejected/escalated/paused。",
      },
    },
    output: {
      schema: COMMON_OUTPUT_SCHEMA,
      render: renderJson,
    },
    async execute(args) {
      const res = await pthRequest(config, {
        path: "/api/v1/kernel/tasks",
        query: {
          limit: args.limit,
          status: args.status,
        },
      });
      if (!res.ok) return res;
      const tasks = Array.isArray(res.data) ? res.data : [];
      return { ok: true, tasks, count: tasks.length };
    },
  }));

  // pth_cancel：取消任务
  ctx.tools.register(defineTool({
    name: "pth_cancel",
    description: `取消一个 PTH 任务。返回 { ok:true, result }（result 为 API 返回体）；失败返回 { ok:false, error }。`,
    parameters: {
      taskId: {
        type: "string",
        required: true,
        description: "pth_submit 返回的任务 ID。",
      },
    },
    output: {
      schema: COMMON_OUTPUT_SCHEMA,
      render: renderJson,
    },
    async execute(args) {
      const res = await pthRequest(config, {
        path: `/api/v1/kernel/tasks/${encodeURIComponent(args.taskId)}/cancel`,
        method: "POST",
        body: {},
      });
      if (!res.ok) return res;
      return { ok: true, result: res.data };
    },
  }));

  // pth_transcript：任务轨迹
  ctx.tools.register(defineTool({
    name: "pth_transcript",
    description: `查询 PTH 任务轨迹。返回 { ok:true, transcript }，transcript 含 taskId 与 transcripts 数组（每项含 agentId/summary/events/scorecard/createdAt）。失败返回 { ok:false, error }。`,
    parameters: {
      taskId: {
        type: "string",
        required: true,
        description: "pth_submit 返回的任务 ID。",
      },
    },
    output: {
      schema: COMMON_OUTPUT_SCHEMA,
      render: renderJson,
    },
    async execute(args) {
      const res = await pthRequest(config, {
        path: `/api/v1/kernel/tasks/${encodeURIComponent(args.taskId)}/transcript`,
      });
      if (!res.ok) return res;
      return { ok: true, transcript: res.data };
    },
  }));

  // pth_kernel_status：运行状态全景
  ctx.tools.register(defineTool({
    name: "pth_kernel_status",
    description: `查询 PTH kernel/batch/task 运行状态全景。返回 { ok:true, status }，status 含 kernel/autopilot/batches/tasks/watchdog/collectedAt。失败返回 { ok:false, error }。`,
    parameters: {},
    output: {
      schema: COMMON_OUTPUT_SCHEMA,
      render: renderJson,
    },
    async execute() {
      const res = await pthRequest(config, { path: "/api/v1/kernel/status" });
      if (!res.ok) return res;
      return { ok: true, status: res.data };
    },
  }));

  // pth_worker_activity：角色活动
  ctx.tools.register(defineTool({
    name: "pth_worker_activity",
    description: `查询某 worker 角色最近活动。返回 { ok:true, activity }，activity 含 role/sinceSec/inflight/history；history 每项含 taskId/at/summary/events/hasContext。失败返回 { ok:false, error }。`,
    parameters: {
      role: {
        type: "string",
        required: true,
        description: "角色 ID，例如 developer/coder/tester/analyst；先 pth_roles() 查可用角色。",
      },
      sinceSec: {
        type: "number",
        description: "回溯秒数，1-86400，默认 60。",
      },
    },
    output: {
      schema: COMMON_OUTPUT_SCHEMA,
      render: renderJson,
    },
    async execute(args) {
      const res = await pthRequest(config, {
        path: `/api/v1/kernel/workers/${encodeURIComponent(args.role)}/activity`,
        query: { sinceSec: args.sinceSec },
      });
      if (!res.ok) return res;
      return { ok: true, activity: res.data };
    },
  }));

  // pth_worker_context：角色在飞上下文
  ctx.tools.register(defineTool({
    name: "pth_worker_context",
    description: `查询某 worker 角色在飞任务上下文的有界投影。返回 { ok:true, context }，context 含 role/tasks。失败返回 { ok:false, error }。`,
    parameters: {
      role: {
        type: "string",
        required: true,
        description: "角色 ID，例如 developer/coder/tester/analyst。",
      },
      last: {
        type: "number",
        description: "返回最近 N 个上下文，1-100，默认 10。",
      },
    },
    output: {
      schema: COMMON_OUTPUT_SCHEMA,
      render: renderJson,
    },
    async execute(args) {
      const res = await pthRequest(config, {
        path: `/api/v1/kernel/workers/${encodeURIComponent(args.role)}/context`,
        query: { last: args.last },
      });
      if (!res.ok) return res;
      return { ok: true, context: res.data };
    },
  }));

  // pth_roles：角色/标签表
  ctx.tools.register(defineTool({
    name: "pth_roles",
    description: `查询 PTH 已注册角色与标签路由表。返回 { ok:true, roles:[...] }；每项含 roleId/tags/description 等，用于确认 pth_submit 的 tags 是否合法。失败返回 { ok:false, error }。`,
    parameters: {},
    output: {
      schema: COMMON_OUTPUT_SCHEMA,
      render: renderJson,
    },
    async execute() {
      const res = await pthRequest(config, { path: "/api/v1/observe/roles" });
      if (!res.ok) return res;
      const roles = Array.isArray(res.data) ? res.data : [];
      return { ok: true, roles };
    },
  }));
}
