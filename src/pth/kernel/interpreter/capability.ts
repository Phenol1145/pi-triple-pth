import type { LlmFn } from "./llm-fn.js";
import type { Interpreter } from "./types.js";
import type { DataWorldAccess } from "../storage/index.js";
import type { PgMemoryStore } from "../storage/memory-store-pg.js";
import type { Toolstore } from "./toolstore.js";

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
  /** toolstore 文件通道（§0.5）：注入 fs.readText（只读 toolstore 目录） */
  toolstore?: Toolstore;
  /** 环境感知（env.inspect）：按语言返回 kernel 状态摘要（LLM 友好版——变量/函数概览） */
  inspect?: (lang?: string) => Promise<unknown>;
}): Record<string, unknown> {
  return {
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
        } }
      : {}),
    // Finding F1（Important）修复：memory 整体注入时其方法 retrieve/write/bumpHitCount 均用
    // this.pool——裸对象注入后若被解构/提取（`const { retrieve } = memory; retrieve()`）this 丢失。
    // bindAll 为所有函数属性（含原型链类方法）逐个 bind，非函数属性（pool 句柄）不注入 vm（安全边界）。
    // 记忆查询（收敛 2026-08-09）：memory.query = 受限只读 SQL（与 agent 侧 memory.sql 同源执行器）
    memory: { ...bindAll(deps.dataWorld.memory), query: deps.dataWorld.queryReadOnly.bind(deps.dataWorld) },
    skills: {
      get: async (name: string) => {
        // v1：skill 数据对象读取（Spec C skills 表——v1 独立表占位）
        // 简化：返回空（v1 不实现完整 skill 加载，Spec B 任务接入时扩展）
        return undefined;
      },
    },
    tasks: {
      // Finding F1 修复：peek/submit 是方法提取——vm 里 `tasks.peek()` 的 this 是 capabilities.tasks
      // 对象而非 TaskStore 实例 → this.pool undefined → TypeError（真实 PgTaskStore 用 this.pool.query）。
      peek: deps.dataWorld.tasks.candidates.bind(deps.dataWorld.tasks),
      submit: deps.dataWorld.tasks.submit.bind(deps.dataWorld.tasks),
    },
    ...(deps.bash ? { bash: deps.bash } : {}),
    ...(deps.python ? { python: deps.python } : {}),
  };
}

/**
 * bindAll：为对象的所有函数属性逐个 bind 到原对象，返回包装对象（防方法提取丢 this）。
 * 类方法位于 prototype（Object.keys 只能拿到自身可枚举属性），故沿原型链收集
 * （到 Object.prototype 为止；constructor 除外）。非函数属性不拷贝——底层句柄
 * （如 pool）不注入 vm context（与「context 默认空、只注入白名单」的能力模型一致）。
 */
function bindAll<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  const targets: Array<[string, (...args: unknown[]) => unknown]> = [];
  let proto: object | null = obj;
  const seen = new Set<string>();
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (desc && typeof desc.value === "function" && key !== "constructor") {
        targets.push([key, desc.value]);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  for (const [key, fn] of targets) out[key] = fn.bind(obj);
  return out as T;
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
