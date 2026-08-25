/**
 * tool-command-adapters.ts —— Tool-Reg v2 Command adapter（Wave 2）。
 *
 * Adapter 是纯翻译器，只返回 `ExecutionRequest` 或 `deny`：
 *   - 不持有 ExecutePorts；
 *   - 不直接执行；
 *   - 不返回最终 execute/await-approval 决策。
 *
 * 标准 adapter：
 *   builtinAdapter  → internal request（capability ref）
 *   externalAdapter → external request（argv 数组，永不拼 shell 字符串）
 *   programAdapter  → language request（ts program）
 *   agentAdapter    → agent request（子 agent 角色）
 */

import type { CommandFeedback } from "./command-feedback.js";
import type { ExecutionRequest } from "./execution-command.js";

export type ToolCommandAdapterResult =
  | { readonly kind: "request"; readonly request: ExecutionRequest }
  | { readonly kind: "deny"; readonly reason: string; readonly feedback?: CommandFeedback };

export type ToolCommandAdapter = (args: Readonly<Record<string, unknown>>) => ToolCommandAdapterResult;

export interface AdapterTargetDomain {
  /** compiled = 进程内 engine（ts/python 等）；network = 外部命令/工具容器。 */
  readonly domain?: "compiled" | "network";
}

export interface AdapterTargetResolver {
  resolve(input: { target?: string | null; backend?: string; domain?: "compiled" | "network" }): { ok: true; target: string } | { ok: false; error: string };
}

const DEFAULT_DOMAIN_TARGETS: Record<"compiled" | "network", string> = {
  compiled: "engine-ts",
  network: "sandbox",
};

export function createDefaultTargetResolver(): AdapterTargetResolver {
  return {
    resolve({ target, backend, domain }) {
      if (target && target.trim() !== "") return { ok: true, target };
      if (backend && backend.trim() !== "") return { ok: true, target: backend };
      if (domain) return { ok: true, target: DEFAULT_DOMAIN_TARGETS[domain] };
      return { ok: false, error: "target resolution failed: explicit target/backend/domain are all missing (fail-closed)" };
    },
  };
}

// ── argvTemplate 槽位规则 ──────────────────────────────────────────

export interface ArgvTemplateOptions {
  /** 允许槽位值以 `-` 开头（默认 false——防 flag 注入；可用 `--` 分隔）。 */
  readonly allowDashValues?: boolean;
}

const ARGV_SLOT_RE = /\{\{([a-zA-Z0-9_.-]+)\}\}/g;

/** 校验 argvTemplate 槽位必须存在于 parameters.properties。 */
export function validateArgvTemplate(
  template: readonly string[],
  parameters: { properties: Record<string, unknown>; required: string[] },
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const seg of template) {
    for (const m of seg.matchAll(ARGV_SLOT_RE)) {
      const slot = m[1]!;
      if (!(slot in parameters.properties)) {
        errors.push(`argvTemplate slot "${slot}" is not declared in parameters.properties`);
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** 渲染 argv 数组。缺失槽 → 若 required 返回 deny；可选槽未提供则跳过该段。 */
export function renderArgv(
  template: readonly string[],
  args: Readonly<Record<string, unknown>>,
  parameters: { properties: Record<string, unknown>; required: string[] },
  opts: ArgvTemplateOptions = {},
): { ok: true; argv: string[] } | { ok: false; reason: string; feedback?: CommandFeedback } {
  const argv: string[] = [];
  for (const seg of template) {
    let rendered = seg;
    let missing = false;
    for (const m of seg.matchAll(ARGV_SLOT_RE)) {
      const slot = m[1]!;
      const raw = args[slot];
      if (raw === undefined || raw === null) {
        if (parameters.required.includes(slot)) {
          return {
            ok: false,
            reason: `argvTemplate missing required slot "${slot}"`,
            feedback: {
              layer: "command",
              class: "adapter-config",
              code: "ADAPTER_ARGV_MISSING_SLOT",
              message: `argvTemplate requires slot "${slot}" but it is missing from arguments`,
              retryable: true,
            },
          };
        }
        missing = true;
        break;
      }
      const value = String(raw);
      if (!opts.allowDashValues && value.startsWith("-")) {
        return {
          ok: false,
          reason: `argvTemplate slot "${slot}" value starts with "-" (flag injection risk); use "--" or allowDashValues`,
          feedback: {
            layer: "command",
            class: "adapter-config",
            code: "ADAPTER_ARGV_DASH_VALUE",
            message: `slot "${slot}" value starts with "-"; dash-prefixed slot values are rejected by default`,
            retryable: false,
          },
        };
      }
      rendered = rendered.replace(`{{${slot}}}`, value);
    }
    if (!missing) argv.push(rendered);
  }
  return { ok: true, argv };
}

// ── 标准 adapters ──────────────────────────────────────────────────

export function builtinAdapter(ref: string): ToolCommandAdapter {
  if (ref.trim() === "") throw new Error("builtinAdapter: ref is required");
  return (args) => ({
    kind: "request",
    request: { kind: "internal", tool: ref, capability: ref, args },
  });
}

export interface ExternalAdapterSpec {
  readonly ref: string;
  readonly argvTemplate: readonly string[];
  readonly target?: string;
  readonly backend?: string;
  readonly domain?: "compiled" | "network";
  readonly parameters: { properties: Record<string, unknown>; required: string[] };
  readonly allowDashValues?: boolean;
  readonly resolver?: AdapterTargetResolver;
}

export function externalAdapter(spec: ExternalAdapterSpec): ToolCommandAdapter {
  if (spec.ref.trim() === "") throw new Error("externalAdapter: ref is required");
  const schemaCheck = validateArgvTemplate(spec.argvTemplate, spec.parameters);
  if (!schemaCheck.ok) {
    throw new Error(`externalAdapter ${spec.ref}: ${schemaCheck.errors.join("; ")}`);
  }
  const resolver = spec.resolver ?? createDefaultTargetResolver();
  return (args) => {
    const rendered = renderArgv(spec.argvTemplate, args, spec.parameters, { allowDashValues: spec.allowDashValues });
    if (!rendered.ok) return { kind: "deny", reason: rendered.reason, feedback: rendered.feedback };
    const target = resolver.resolve({
      target: spec.target ?? (typeof args["target"] === "string" ? args["target"] : undefined),
      backend: spec.backend ?? (typeof args["backend"] === "string" ? args["backend"] : undefined),
      domain: spec.domain,
    });
    if (!target.ok) {
      return {
        kind: "deny",
        reason: target.error,
        feedback: {
          layer: "command",
          class: "target-resolution",
          code: "TARGET_RESOLUTION_FAILED",
          message: target.error,
          retryable: true,
        },
      };
    }
    return {
      kind: "request",
      request: {
        kind: "external",
        tool: spec.ref,
        argv: rendered.argv,
        target: target.target,
      },
    };
  };
}

export function programAdapter(source: string): ToolCommandAdapter {
  if (source.trim() === "") throw new Error("programAdapter: source is required");
  return (args) => ({
    kind: "request",
    request: {
      kind: "language",
      tool: "program",
      language: "ts",
      code: `const args = ${JSON.stringify(args ?? {})};\n${source}`,
      mode: "program",
    },
  });
}

export interface AgentAdapterSpec {
  readonly role: string;
  readonly input?: string;
  readonly output?: string;
}

export function agentAdapter(spec: AgentAdapterSpec): ToolCommandAdapter {
  if (spec.role.trim() === "") throw new Error("agentAdapter: role is required");
  return (args) => ({
    kind: "request",
    request: {
      kind: "agent",
      tool: `agent:${spec.role}`,
      role: spec.role,
      input: spec.input,
      output: spec.output,
    },
  });
}

// ── CommandAdapterRegistry ─────────────────────────────────────────

export class CommandAdapterRegistry {
  private readonly adapters = new Map<string, ToolCommandAdapter>();

  register(id: string, adapter: ToolCommandAdapter): void {
    if (id.trim() === "") throw new Error("adapter id is required");
    if (this.adapters.has(id)) throw new Error(`adapter already registered: ${id}`);
    this.adapters.set(id, adapter);
  }

  get(id: string): ToolCommandAdapter | undefined {
    return this.adapters.get(id);
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  list(): readonly { id: string; adapter: ToolCommandAdapter }[] {
    return [...this.adapters.entries()].map(([id, adapter]) => ({ id, adapter }));
  }

  /** 未注册 → deny（adapter-not-found）。 */
  call(id: string, args: Readonly<Record<string, unknown>>): ToolCommandAdapterResult {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      return {
        kind: "deny",
        reason: `adapter not found: ${id}`,
        feedback: {
          layer: "command",
          class: "adapter-not-found",
          code: "ADAPTER_NOT_FOUND",
          message: `no adapter registered for "${id}"`,
          retryable: false,
        },
      };
    }
    return adapter(args);
  }
}

// ── 自定义 adapter 静态分析预留入口 ────────────────────────────────

export interface AdapterStaticAnalysisResult {
  readonly ok: boolean;
  readonly findings: readonly string[];
}

/**
 * 自定义 adapter 预留的静态分析入口。
 * v1 只做显式危险模式检查；完整 AST 分析由提案审核通道执行。
 */
export function analyzeCustomAdapterSource(source: string): AdapterStaticAnalysisResult {
  const findings: string[] = [];
  const dangerous = [
    { re: /\brequire\s*\(\s*["'](?:fs|child_process|net|http)["']\s*\)/, label: "require fs/child_process/net/http" },
    { re: /\bimport\s*\(\s*["'](?:fs|child_process|net|http)["']\s*\)/, label: "dynamic import fs/child_process/net/http" },
    { re: /\bprocess\s*\.\s*(?:exec|spawn|fork)\s*\(/, label: "process.exec/spawn/fork" },
  ];
  for (const d of dangerous) {
    if (d.re.test(source)) findings.push(`custom adapter source contains ${d.label}`);
  }
  return { ok: findings.length === 0, findings };
}
