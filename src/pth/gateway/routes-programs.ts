import type { FastifyInstance } from "fastify";
import type { AgentEngine } from "../core/agent-engine.js";
import type { ProgramStore } from "../programs/store.js";
import type { ProgramManifest } from "../programs/types.js";
import type { ComponentManifest, ComponentType } from "../components/store.js";
import { COMPONENT_TYPES } from "../components/store.js";
import { writeSSE } from "./sse.js";
import { randomUUID } from "node:crypto";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function validateManifest(raw: unknown): { ok: true; manifest: ProgramManifest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "manifest must be an object" };
  const m = raw as Record<string, unknown>;

  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) {
    return { ok: false, error: `invalid name: "${m.name}" (must match ${NAME_RE.source})` };
  }
  if (typeof m.systemPrompt !== "string" || m.systemPrompt.includes("..") || m.systemPrompt.startsWith("/")) {
    return { ok: false, error: `invalid systemPrompt: "${m.systemPrompt}"` };
  }
  if (m.timeoutSec !== undefined && (typeof m.timeoutSec !== "number" || m.timeoutSec < 1 || m.timeoutSec > 3600)) {
    return { ok: false, error: "timeoutSec must be 1-3600" };
  }
  if (m.skills !== undefined && (!Array.isArray(m.skills) || m.skills.some((s) => typeof s !== "string"))) {
    return { ok: false, error: "skills must be an array of strings" };
  }
  if (m.tools !== undefined && (!Array.isArray(m.tools) || m.tools.some((s) => typeof s !== "string"))) {
    return { ok: false, error: "tools must be an array of strings" };
  }

  return {
    ok: true,
    manifest: {
      name: m.name as string,
      description: m.description as string | undefined,
      model: m.model as string | undefined,
      provider: m.provider as string | undefined,
      thinking: m.thinking as string | undefined,
      systemPrompt: m.systemPrompt as string,
      skills: m.skills as string[] | undefined,
      tools: m.tools as string[] | undefined,
      excludeTools: m.excludeTools as string[] | undefined,
      input: m.input as { schema?: Record<string, unknown> } | undefined,
      timeoutSec: m.timeoutSec as number | undefined,
    },
  };
}

/**
 * 构件清单分派校验（F/WP4 Task 17）。
 * type 缺省 → agent-program（旧 agent.json 原样通过）；agent-program → 原 validateManifest 逻辑；
 * 其余类型 → 最小校验（name/type 合法、payload 结构骨架校验）。
 */
function validateComponentManifest(
  raw: unknown,
): { ok: true; manifest: ComponentManifest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "manifest must be an object" };
  }
  const m = raw as Record<string, unknown>;
  let type: ComponentType = "agent-program";
  if (m.type !== undefined) {
    if (typeof m.type !== "string" || !(COMPONENT_TYPES as readonly string[]).includes(m.type)) {
      return { ok: false, error: `invalid type: must be one of ${COMPONENT_TYPES.join(" | ")}` };
    }
    type = m.type as ComponentType;
  }

  if (type === "agent-program") {
    const v = validateManifest(raw);
    if (!v.ok) return v;
    return {
      ok: true,
      manifest: { type, ...v.manifest },
    };
  }

  // 其余类型：最小校验
  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) {
    return { ok: false, error: `invalid name: "${m.name}" (must match ${NAME_RE.source})` };
  }
  if (m.description !== undefined && typeof m.description !== "string") {
    return { ok: false, error: "description must be a string" };
  }
  if (m.version !== undefined && typeof m.version !== "string") {
    return { ok: false, error: "version must be a string" };
  }
  if (m.payload !== undefined) {
    if (typeof m.payload !== "object" || m.payload === null || Array.isArray(m.payload)) {
      return { ok: false, error: "payload must be a JSON object" };
    }
  }
  for (const f of ["targetSlot", "legalAuth"]) {
    if (m[f] !== undefined && typeof m[f] !== "string") {
      return { ok: false, error: `${f} must be a string` };
    }
  }

  return {
    ok: true,
    manifest: {
      type,
      name: m.name as string,
      description: m.description as string | undefined,
      version: m.version as string | undefined,
      payload: m.payload as Record<string, unknown> | undefined,
      targetSlot: m.targetSlot as string | undefined,
      legalAuth: m.legalAuth as string | undefined,
    },
  };
}

/**
 * 构件上传共用处理（POST /api/v1/components 与 POST /api/v1/programs 同 handler）。
 * type 为请求声明类型（/programs 固定 agent-program 兼容别名）。
 */
async function handleComponentUpload(
  store: ProgramStore,
  tenantId: string,
  type: ComponentType,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const manifestRaw0 = body.manifest as unknown;

  // manifest 显式 type 与请求 type 冲突 → 拒绝
  if (
    manifestRaw0 &&
    typeof manifestRaw0 === "object" &&
    !Array.isArray(manifestRaw0) &&
    (manifestRaw0 as Record<string, unknown>).type !== undefined &&
    (manifestRaw0 as Record<string, unknown>).type !== type
  ) {
    return { status: 400, body: { error: `manifest type does not match request type "${type}"` } };
  }

  // 请求 type 为准，注入后分派校验
  const m = validateComponentManifest(
    manifestRaw0 && typeof manifestRaw0 === "object" && !Array.isArray(manifestRaw0)
      ? { ...(manifestRaw0 as Record<string, unknown>), type }
      : manifestRaw0,
  );
  if (!m.ok) {
    return { status: 400, body: { error: `Invalid manifest: ${m.error}` } };
  }
  const manifest = m.manifest;

  // Decode archive
  const archiveBase64 = body.archive as unknown;
  if (!archiveBase64 || typeof archiveBase64 !== "string") {
    return { status: 400, body: { error: "missing archive (base64-encoded tar.gz)" } };
  }
  let archive: Buffer;
  try {
    archive = Buffer.from(archiveBase64, "base64");
  } catch {
    return { status: 400, body: { error: "invalid base64 encoding" } };
  }

  if (archive.length > 2_097_152) { // 2MB
    return { status: 413, body: { error: "archive too large (max 2MB)" } };
  }

  // Decompress gzip
  let tarBuf: Buffer;
  try {
    const { gunzipSync } = await import("node:zlib");
    tarBuf = gunzipSync(archive);
  } catch {
    return { status: 400, body: { error: "archive is not a valid gzip file" } };
  }

  const result = await store.save(tenantId, manifest, tarBuf);
  if (!result.ok) {
    return { status: 400, body: { error: result.error } };
  }

  return {
    status: 201,
    body: {
      type: result.value.type,
      name: result.value.name,
      version: result.value.version,
      bytes: archive.length,
    },
  };
}

/** Validate input against manifest.input.schema (JSON Schema-like, simple). */
function validateInput(schema: Record<string, unknown> | undefined, input: unknown): string | null {
  if (!schema) return null; // no schema = freeform
  if (typeof schema !== "object" || (schema as any).type !== "object") return null;

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "input must be a JSON object matching the program schema";
  }
  const s = schema as any;
  if (s.required && Array.isArray(s.required)) {
    for (const key of s.required) {
      if (!(key in (input as object))) {
        return `missing required field: "${key}"`;
      }
    }
  }
  return null;
}

/** Render structured input as a prompt string. */
function renderInputPrompt(input: unknown, schema: Record<string, unknown> | undefined): string {
  if (!schema) {
    // No schema: input is a plain string；PTL k=v 形式单 text 键时解包
    if (typeof input === "string") return input;
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const keys = Object.keys(input as object);
      if (keys.length === 1 && keys[0] === "text") return String((input as any).text ?? "");
      return JSON.stringify(input, null, 2);
    }
    return String(input ?? "");
  }
  // Has schema: render as structured prompt
  return `任务参数:\n${JSON.stringify(input, null, 2)}`;
}

export function registerProgramRoutes(
  app: FastifyInstance,
  engine: AgentEngine,
  store: ProgramStore,
) {
  // POST /api/v1/components — submit（构件类型分派；/programs 为 agent-program 兼容别名）
  app.post("/api/v1/components", async (req, reply) => {
    const tenantId = req.auth.tenantId;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = body.type as unknown;
    if (typeof type !== "string" || !(COMPONENT_TYPES as readonly string[]).includes(type)) {
      return reply.status(400).send({ error: `Invalid type: must be one of ${COMPONENT_TYPES.join(" | ")}` });
    }
    const r = await handleComponentUpload(store, tenantId, type as ComponentType, body);
    return reply.status(r.status).send(r.body);
  });

  // POST /api/v1/programs — submit（agent-program 兼容别名）
  app.post("/api/v1/programs", async (req, reply) => {
    const tenantId = req.auth.tenantId;
    const r = await handleComponentUpload(store, tenantId, "agent-program", (req.body ?? {}) as Record<string, unknown>);
    return reply.status(r.status).send(r.body);
  });

  // GET /api/v1/programs — list
  app.get("/api/v1/programs", async (req) => {
    const programs = await store.list(req.auth.tenantId);
    return programs;
  });

  // GET /api/v1/programs/:name — detail
  app.get("/api/v1/programs/:name", async (req, reply) => {
    const name = (req.params as any).name as string;
    const result = await store.get(req.auth.tenantId, name);
    if (!result.ok) return reply.status(404).send({ error: result.error });
    return {
      name: result.value.name,
      version: result.value.version,
      manifest: result.value.manifest,
    };
  });

  // DELETE /api/v1/programs/:name
  app.delete("/api/v1/programs/:name", async (req, reply) => {
    const name = (req.params as any).name as string;
    const result = await store.delete(req.auth.tenantId, name);
    if (!result.ok) return reply.status(404).send({ error: result.error });
    return { ok: true };
  });

  // POST /api/v1/programs/:name/run — SSE stream
  app.post("/api/v1/programs/:name/run", async (req, reply) => {
    const tenantId = req.auth.tenantId;
    const name = (req.params as any).name as string;
    const body = req.body as any || {};
    const input = body.input;
    const reqVersion = body.version as number | undefined;

    // Resolve program
    const prog = await store.get(tenantId, name, reqVersion);
    if (!prog.ok) {
      return reply.status(404).send({ error: prog.error });
    }
    const { manifest, version: resolvedVersion, root } = prog.value;

    // Validate input against schema
    const inputErr = validateInput(manifest.input?.schema, input);
    if (inputErr) {
      return reply.status(400).send({ error: inputErr });
    }

    // Render prompt
    const text = renderInputPrompt(input, manifest.input?.schema);

    // Create session with program context
    const sessionResult = await engine.createSession({
      tenantId,
      project: "default",
      provider: manifest.provider,
      model: manifest.model,
      thinkingLevel: manifest.thinking,
      program: {
        root,
        systemPrompt: manifest.systemPrompt,
        skills: manifest.skills,
        tools: manifest.tools,
        excludeTools: manifest.excludeTools,
        timeoutSec: manifest.timeoutSec ?? 300,
      },
    });

    if (!sessionResult.ok) {
      return reply.status(429).send({ error: sessionResult.error });
    }
    const sessionId = sessionResult.data.sessionId;

    // — All validation done, start SSE stream —
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Program-Version": String(resolvedVersion),
      "X-Session-Id": sessionId,
    });

    try {
      for await (const event of engine.prompt(sessionId, tenantId, text)) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      reply.raw.write("data: [DONE]\n\n");
    } catch (err: any) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`);
    }
    reply.raw.end();

    // one-shot run：流结束后销毁会话（防会话泄漏撞租户上限；X-Session-Id 仅供运行中 abort）
    setImmediate(() => {
      engine.destroySession(sessionId, tenantId).catch(() => { /* best-effort */ });
    });
  });
}
