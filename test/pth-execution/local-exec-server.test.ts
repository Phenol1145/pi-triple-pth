import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpExecutionClient, ExecutionClientError, EXECUTION_PROTOCOL_VERSION_V11, EXECUTION_WIRE } from "@away_from/shared/execution";
import { startLocalExecServer, type RunningLocalExecServer } from "../../src/pth/execution/local-exec-server.js";

const cleanup: string[] = [];
const servers: RunningLocalExecServer[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((s) => s.close()));
  await Promise.allSettled(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ptl-local-exec-"));
  cleanup.push(dir);
  return dir;
}

async function start(mappings: { hostRoot: string; execRoot: string }[]): Promise<{ baseUrl: string; execRoot: string }> {
  const execRoot = await workspace();
  const running = await startLocalExecServer({
    token: "local-exec-secret",
    port: 0,
    mappings: mappings.map((m) => ({ ...m, execRoot: m.execRoot === "<root>" ? execRoot : m.execRoot })),
  });
  servers.push(running);
  return { baseUrl: running.baseUrl, execRoot };
}

describe("P2：本地执行器（execution/v1.1 · profile=host · pathMapping）", () => {
  it("/health 免认证；/capabilities v1.1 位图；错误 token 401", async () => {
    const { baseUrl } = await start([{ hostRoot: "/data/workspaces", execRoot: "<root>" }]);
    const health = await fetch(`${baseUrl}${EXECUTION_WIRE.paths.health}`);
    expect(health.status).toBe(200);

    const caps = await fetch(`${baseUrl}${EXECUTION_WIRE.paths.capabilities}`, {
      headers: { authorization: "Bearer local-exec-secret" },
    });
    expect(caps.status).toBe(200);
    expect(await caps.json()).toMatchObject({
      version: EXECUTION_PROTOCOL_VERSION_V11,
      pathMapping: true,
      modes: { sync: true, stream: true, interactive: false, persistent: false },
    });

    const bad = await fetch(`${baseUrl}${EXECUTION_WIRE.paths.capabilities}`, {
      headers: { authorization: "Bearer wrong" },
    });
    expect(bad.status).toBe(401);
  });

  it("sync：cwd 经已登记 mapping 翻译后在宿主执行", async () => {
    const { baseUrl, execRoot } = await start([{ hostRoot: "/data/workspaces", execRoot: "<root>" }]);
    const proj = join(execRoot, "proj");
    await mkdir(proj, { recursive: true });

    const client = new HttpExecutionClient({ baseUrl, token: "local-exec-secret" });
    const result = await client.execute({
      cmd: ["node", "-e", "console.log(process.cwd())"],
      mode: "sync",
      cwd: "/data/workspaces/proj",
      pathMapping: { hostRoot: "/data/workspaces", execRoot },
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout.trim()).toBe(await realpath(proj));
  });

  it("profile 自提升拒绝（400 INVALID_REQUEST）；未登记 cwd → CWD_NOT_ALLOWED", async () => {
    const { baseUrl } = await start([{ hostRoot: "/data/workspaces", execRoot: "<root>" }]);
    const client = new HttpExecutionClient({ baseUrl, token: "local-exec-secret" });

    await expect(client.execute({ cmd: "true", mode: "sync", profile: "sandbox-untrusted" }))
      .rejects.toMatchObject({ name: "ExecutionClientError", code: EXECUTION_WIRE.errorCodes.invalidRequest });

    await expect(client.execute({ cmd: "true", mode: "sync", cwd: "/outside/root" }))
      .rejects.toMatchObject({ name: "ExecutionClientError", code: EXECUTION_WIRE.errorCodes.cwdNotAllowed });
  });

  it("stream：SSE 全链路（增量输出 + done + 回放）", async () => {
    const { baseUrl } = await start([{ hostRoot: "/data/workspaces", execRoot: "<root>" }]);
    const client = new HttpExecutionClient({ baseUrl, token: "local-exec-secret" });
    const outputs: string[] = [];
    let done = false;
    const execId = await client.stream(
      {
        cmd: ["node", "-e", "process.stdout.write('a');setTimeout(()=>process.stdout.write('b'),40)"],
        mode: "stream",
      },
      {
        onOutput: (e) => outputs.push(e.data),
        onDone: (e) => { done = e.exitCode === 0; },
      },
    );
    expect(execId).toBeTruthy();
    expect(done).toBe(true);
    expect(outputs.join("")).toBe("ab");
  });

  it("硬约束：超时杀进程组（timedOut + SIGKILL）；输出上限截断", async () => {
    const { baseUrl } = await start([{ hostRoot: "/data/workspaces", execRoot: "<root>" }]);
    const client = new HttpExecutionClient({ baseUrl, token: "local-exec-secret" });

    const timed = await client.execute({ cmd: ["sleep", "10"], mode: "sync", timeoutMs: 150 });
    expect(timed.timedOut).toBe(true);
    expect(timed.exitCode).toBe(137);
    expect(timed.signal).toBe("SIGKILL");

    const truncated = await client.execute({
      cmd: ["node", "-e", "process.stdout.write('x'.repeat(10000))"],
      mode: "sync",
      maxStdoutBytes: 8,
    });
    expect(truncated.stdout).toHaveLength(8);
    expect(truncated.truncated).toMatchObject({ field: "stdout", keptLen: 8 });
  });

  it("错误信封结构化：非法 mode 被 server 校验拒绝", async () => {
    const { baseUrl } = await start([{ hostRoot: "/data/workspaces", execRoot: "<root>" }]);
    const res = await fetch(`${baseUrl}${EXECUTION_WIRE.paths.exec}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-exec-secret" },
      body: JSON.stringify({ cmd: "true", mode: "interactive" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: EXECUTION_WIRE.errorCodes.modeNotSupported } });
    expect(ExecutionClientError).toBeDefined();
  });
});
