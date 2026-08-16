import type { LlmFn } from "../../kernel/interpreter/llm-fn.js";
import type { Interpreter } from "@away_from/pth-sandbox";
import type { DataWorldAccess } from "../../kernel/storage/index.js";
import type { PgMemoryStore } from "@away_from/pth-memory";
import type { Toolstore } from "../../kernel/interpreter/toolstore.js";
import { buildExtensions } from "../../kernel/extensions/index.js";
import { createExtCapability } from "../../kernel/interpreter/ext-capability.js";
import { wrapValidated } from "../../kernel/ptc/contract.js";
import { filterVisibleEntries, listSkills, getSkill, maintainSkillWrite, maintainSkillArchive, proposeSkillMaintenance, reviewSkillProposal } from "@away_from/pth-memory";
import { isIP } from "node:net";
import { pthConfig } from "../../config/index.js";
import http from "node:http";
import https from "node:https";
import { promises as dnsPromises } from "node:dns";

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
  /** 角色 ID（B4 Phase 3：skills.maintain 仅注入 memory-keeper） */
  roleId?: string;
}): Record<string, unknown> {
  // 标准扩展包（memory/context/model——SPEC 2026-08-09）：能力注入 + 预置对象
  const ext = buildExtensions({ dataWorld: deps.dataWorld, toolstore: deps.toolstore, sessionRef: deps.sessionRef });
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
        await (deps.dataWorld.memory as PgMemoryStore).write(entry as never, { force: true });
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
    state: createRecallState(deps.dataWorld.memory, deps.sessionRef),
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
      list: async () => (await listSkills(deps.dataWorld.memory)).filter((s) => s.status !== "draft"),
      get: async (name: string) => getSkill(deps.dataWorld.memory, String(name)),
      // B4 Phase 3：维护面只给 memory-keeper（写后冻结；修订 = force + audit / archive + 新条目）
      //   W5 策略：PTH_SKILL_WRITE_POLICY=manual（默认人工闸门）| staged（提案→审核→批准→执行）
      ...(deps.roleId === "memory-keeper"
        ? {
            maintain: {
              write: async (input: { name: string; content: string; anchors?: string[]; force?: boolean; audit?: string; proposalId?: string }) =>
                maintainSkillWrite(deps.dataWorld.memory, input, { policy: pthConfig().str("PTH_SKILL_WRITE_POLICY") as "manual" | "staged" }),
              archive: async (id: string, audit?: string) =>
                maintainSkillArchive(deps.dataWorld.memory, id, audit, { policy: pthConfig().str("PTH_SKILL_WRITE_POLICY") as "manual" | "staged" }),
              propose: async (input: { action: "write" | "archive"; name: string; content?: string; force?: boolean; anchors?: string[]; audit?: string }) =>
                proposeSkillMaintenance(deps.dataWorld.memory, input),
            },
          }
        : {}),
      // B4 W7：对抗性审核只给 controller:adversarial
      ...(deps.roleId === "controller:adversarial"
        ? {
            review: async (proposalId: string, verdict: "pass" | "reject", note?: string) =>
              reviewSkillProposal(deps.dataWorld.memory, proposalId, verdict, note ?? ""),
          }
        : {}),
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

/** DNS 全量解析结果（H9 防护用——任一地址非公网即整体拒绝）。 */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** 可注入的 DNS 解析器（测试注入 / 未来出站策略协同点）。 */
export interface WebLookup {
  (hostname: string): Promise<ResolvedAddress[]>;
}

/** HTTP 响应抽象（默认走 node:http/https，测试可注入）。 */
export interface WebResponse {
  status: number;
  headers: { get(name: string): string | null };
  /** 流式 body——消费方按 chunk 读取；超限时调用 cancel 断开上游。 */
  body(): AsyncIterable<Uint8Array>;
  cancel?(): void;
}

/** 传输层注入点：url + 已受检地址 + 超时信号。 */
export interface WebRequest {
  (url: URL, init: { signal: AbortSignal; addresses: ResolvedAddress[] }): Promise<WebResponse>;
}

export interface WebCapabilityOptions {
  lookup?: WebLookup;
  request?: WebRequest;
}

const WEB_MAX_BYTES = 1024 * 1024;   // 1MB——官方文档页常超 256KB（go.dev/ref/spec ≈ 339KB）
const WEB_TIMEOUT_MS = 30_000;
const WEB_MAX_REDIRECTS = 5;

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

/** 2026-08-15 筛查 H9：字面量层面 SSRF 防护——拒 localhost/私网/链路本地 IP 字面量。
 *  2026-08-16 S0-2：补 DNS rebinding 防护——解析与连接 pin 到同一份已受检地址
 *  （fetchText 先全量解析校验，传输层不再二次解析；重定向逐跳重复校验）。 */
function isPrivateIpLiteral(ip: string): boolean {
  if (isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    const [a, b] = p as [number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b! >= 64 && b! <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  if (isIP(ip) === 6) {
    if (ip === "::1" || ip === "::") return true;
    if (/^f[cd]/.test(ip)) return true;
    if (/^fe[89ab]/.test(ip)) return true;
    if (ip.toLowerCase().startsWith("::ffff:")) return isPrivateIpLiteral(ip.slice(7));
    return false;
  }
  return true;   // 无法判定 → 拒绝
}

function assertPublicLiteralHost(hostname: string): void {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("web.fetchText: localhost 目标被拒（SSRF 防护）");
  }
  if (isIP(host) && isPrivateIpLiteral(host)) {
    throw new Error(`web.fetchText: 非公网 IP 目标被拒（SSRF 防护）: ${host}`);
  }
}

/** 默认解析器：全量 A/AAAA 解析（verbatim 保留 IPv6 字面量）。 */
export const defaultWebLookup: WebLookup = async (hostname) => {
  const resolved = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return resolved.map((r) => ({ address: r.address, family: r.family }));
};

/** DNS rebinding 防线：任一解析结果落在非公网段即整体拒绝（fail-closed）。 */
export function assertPublicResolvedAddresses(hostname: string, addresses: ResolvedAddress[]): void {
  if (addresses.length === 0) {
    throw new Error(`web.fetchText: DNS 无解析结果（拒绝）: ${hostname}`);
  }
  const bad = addresses.find((a) => isPrivateIpLiteral(a.address));
  if (bad) {
    throw new Error(`web.fetchText: DNS 解析到非公网地址被拒（SSRF 防护）: ${hostname} -> ${bad.address}`);
  }
}

async function resolvePublicAddresses(hostname: string, lookup: WebLookup): Promise<ResolvedAddress[]> {
  assertPublicLiteralHost(hostname);
  const addresses = await lookup(hostname);
  assertPublicResolvedAddresses(hostname, addresses);
  return addresses;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 默认传输：node http/https + pin 到 fetchText 已校验的首个地址（不再触发第二次解析）。 */
export async function defaultWebRequest(url: URL, init: { signal: AbortSignal; addresses: ResolvedAddress[] }): Promise<WebResponse> {
  const lib = url.protocol === "https:" ? https : http;
  const address = init.addresses[0]!;
  return new Promise((resolve, reject) => {
    let upstream: ReturnType<typeof lib.request> | null = null;
    const req = lib.request(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: "text/html,text/plain,*/*", "user-agent": "pth-web-fetch/1.0" },
        signal: init.signal,
        lookup: (_hostname, options, callback) => {
          // node http.request 以 all:true 调用 lookup——该分支必须回传地址数组（LookupAddress[]）
          if ((options as { all?: boolean }).all) {
            callback(null, [{ address: address.address, family: address.family || 4 }]);
          } else {
            callback(null, address.address, address.family || 4);
          }
        },
      },
      (res) => {
        upstream = req;
        const headers = res.headers;
        resolve({
          status: res.statusCode ?? 0,
          headers: {
            get: (name) => {
              const value = headers[name.toLowerCase()];
              return Array.isArray(value) ? value[0] ?? null : value ?? null;
            },
          },
          body: async function* () {
            for await (const chunk of res) {
              yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
            }
          },
          cancel: () => {
            res.destroy();
            upstream?.destroy();
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 流式限量读取：累计超 maxBytes 即 cancel 上游并抛错；TextDecoder 流式解码防多字节跨 chunk 断裂。 */
export async function readWebBody(res: WebResponse, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for await (const chunk of res.body()) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        res.cancel?.();
        throw new Error(`web.fetchText: response too large (${total} > ${maxBytes} bytes)`);
      }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (err) {
    res.cancel?.();
    throw err;
  }
}

export function createWebCapability(opts: WebCapabilityOptions = {}): WebCapability {
  const lookup = opts.lookup ?? defaultWebLookup;
  const request = opts.request ?? defaultWebRequest;
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
        let current = url;
        for (let hop = 0; hop <= WEB_MAX_REDIRECTS; hop++) {
          const target = new URL(current);
          const addresses = await resolvePublicAddresses(target.hostname, lookup);
          const res = await request(target, { signal: ctrl.signal, addresses });
          const location = res.headers.get("location");
          if (isRedirect(res.status) && location) {
            res.cancel?.();
            current = new URL(location, target).toString();
            continue;
          }
          if (res.status < 200 || res.status >= 300) {
            res.cancel?.();
            throw new Error(`web.fetchText: HTTP ${res.status} for ${target}`);
          }
          const text = await readWebBody(res, maxBytes);
          // 内容类型判定：HTML 剥标签，其余原样
          const ctype = res.headers.get("content-type") ?? "";
          return /html/i.test(ctype) ? stripHtml(text) : text;
        }
        throw new Error(`web.fetchText: too many redirects (max ${WEB_MAX_REDIRECTS})`);
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

export function createRecallState(
  memory: Pick<PgMemoryStore, "retrieve">,
  sessionRef?: { current: { currentSpace: string } | null },
): RecallState {
  const visible = <T extends { meta?: unknown }>(entries: T[]): T[] =>
    filterVisibleEntries(entries, sessionRef?.current?.currentSpace);
  return {
    async recallFunctions(anchors, opts = {}) {
      const entries = visible(await memory.retrieve({ anchors, kinds: ["tool-function"], status: ["official"] }));
      return entries.slice(0, opts.limit ?? 5).map((e) => ({
        key: (e.anchors[0] ?? e.id).replace(/^fn-/, ""),
        source: e.content,
        spec: e.meta?.spec ?? null,
      }));
    },
    async recallInsights(anchors, opts = {}) {
      const entries = visible(await memory.retrieve({ anchors, kinds: ["task-insight"], status: ["official"] }));
      return entries.slice(0, opts.limit ?? 10).map((e) => e.content);
    },
  };
}
