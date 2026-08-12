import type { LlmFn } from "./llm-fn.js";
import type { Interpreter } from "./types.js";
import type { DataWorldAccess } from "../storage/index.js";
import type { PgMemoryStore } from "../storage/memory-store-pg.js";
import type { Toolstore } from "./toolstore.js";
import { buildExtensions } from "../extensions/index.js";
import { createExtCapability } from "./ext-capability.js";

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
}): Record<string, unknown> {
  // 标准扩展包（memory/context/model——SPEC 2026-08-09）：能力注入 + 预置对象
  const ext = buildExtensions({ dataWorld: deps.dataWorld, toolstore: deps.toolstore, sessionRef: deps.sessionRef });
  // 管理面裁剪（权限 v2 R3——2026-08-10）：worker 执行面只给只读子集——
  //   perf.set/publish/apply（运行时调参/策略）与 model.set（切模型）是管理面写操作，不进注入面；
  //   tasks（peek/submit）整体摘除（task-loop 内部走 store——vm 暴露是历史遗留面）。
  //   系统组件（autopilot/console/lineage）主进程直调，不经能力注入——不受影响。
  const extCaps = { ...ext.capabilities } as Record<string, unknown>;
  const perfFull = extCaps["perf"] as Record<string, unknown> | undefined;
  if (perfFull) extCaps["perf"] = { params: perfFull["params"], status: perfFull["status"], analyze: perfFull["analyze"], list: perfFull["list"] };
  const modelFull = extCaps["model"] as Record<string, unknown> | undefined;
  if (modelFull) extCaps["model"] = { get: modelFull["get"], usage: modelFull["usage"] };
  return {
    ...extCaps,
    // 扩展编排面（2026-08-09 用户裁决：代码库式扩展 + 公共记忆区索引——无注册装载）
    ...createExtCapability({
      toolstore: deps.toolstore!,
      memory: (ext.capabilities["memory"] as { write: (e: { kind: string; content: string; anchors: string[] }) => Promise<unknown> } | undefined),
      registerKernel: deps.registerKernel,
      dbQuery: deps.dataWorld.queryReadOnly?.bind(deps.dataWorld),
    }),
    llm: deps.llm,
    web: createWebCapability(),
    ...(deps.inspect ? { env: { inspect: deps.inspect } } : {}),
    // 召回能力（T6）：后续任务从记忆区召回工具函数/洞察——扁平化闭环（agent 状态 = 记忆文档）
    state: createRecallState(deps.dataWorld.memory),
    // 文件通道（§0.5）：fs.readText 只读 toolstore + fs.list 枚举可用工具
    ...(deps.toolstore
      ? { fs: {
          readText: deps.toolstore.readText.bind(deps.toolstore),
          list: deps.toolstore.list.bind(deps.toolstore),
          // 自修改（v0.8→v0.9 铺垫）：readSource 只读 PTH 源码（/app/src 白名单——
          // 路径校验防越权；worker 读源码 → sandbox 编码 → 提交补丁产物）
          readSource: deps.readSource,
          // 任务工作区（workspace 收敛 2026-08-09）：ts 程序写文件落 tasks/<taskId>/——
          // 自修改产物（补丁/源码）落盘 → archive 归档。白名单：相对路径 + 防穿越
          ...(deps.taskWorkspaceResolve
            ? { task: createTaskFs(deps.taskWorkspaceResolve) }
            : {}),
        } }
      : {}),
    skills: {
      get: async (name: string) => {
        // v1：skill 数据对象读取（Spec C skills 表——v1 独立表占位）
        // 简化：返回空（v1 不实现完整 skill 加载，Spec B 任务接入时扩展）
        return undefined;
      },
    },
    // tasks 能力已摘除（权限 v2 R3）——任务代码不可直接 peek/submit 任务池
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

const WEB_MAX_BYTES = 1024 * 1024;   // 1MB——官方文档页常超 256KB（go.dev/ref/spec ≈ 339KB）
const WEB_TIMEOUT_MS = 30_000;

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

export function createWebCapability(): WebCapability {
  return {
    async fetchText(url, opts = {}) {
      const maxBytes = opts.maxBytes ?? WEB_MAX_BYTES;
      const timeoutMs = opts.timeoutMs ?? WEB_TIMEOUT_MS;
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`web.fetchText: only http(s) URLs allowed (got: ${url.slice(0, 50)})`);
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
        if (!res.ok) throw new Error(`web.fetchText: HTTP ${res.status} for ${url}`);
        const buf = await res.arrayBuffer();
        if (buf.byteLength > maxBytes) {
          throw new Error(`web.fetchText: response too large (${buf.byteLength} > ${maxBytes} bytes)`);
        }
        const text = new TextDecoder().decode(buf);
        // 内容类型判定：HTML 剥标签，其余原样
        const ctype = res.headers.get("content-type") ?? "";
        return /html/i.test(ctype) ? stripHtml(text) : text;
      } finally {
        clearTimeout(timer);
      }
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

export function createRecallState(memory: Pick<PgMemoryStore, "retrieve">): RecallState {
  return {
    async recallFunctions(anchors, opts = {}) {
      const entries = await memory.retrieve({ anchors, kinds: ["tool-function"], status: ["official"] });
      return entries.slice(0, opts.limit ?? 5).map((e) => ({
        key: (e.anchors[0] ?? e.id).replace(/^fn-/, ""),
        source: e.content,
        spec: e.meta?.spec ?? null,
      }));
    },
    async recallInsights(anchors, opts = {}) {
      const entries = await memory.retrieve({ anchors, kinds: ["task-insight"], status: ["official"] });
      return entries.slice(0, opts.limit ?? 10).map((e) => e.content);
    },
  };
}
