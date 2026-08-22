import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  validateServiceManifest,
  ServiceManifestError,
  type HostServiceManifest,
} from "../../src/pth/services/service-manifest.js";
import {
  defaultServiceRegistryPath,
  generateServiceToken,
  loadServiceRegistry,
  saveServiceRegistry,
} from "../../src/pth/services/service-registry.js";
import {
  downHostService,
  statusHostService,
  upHostService,
} from "../../src/pth/services/service-supervisor.js";
import { buildExecutionBackendRegistry } from "../../src/pth/execution/backend-registry.js";
import { resolveServiceToken } from "../../src/pth/services/cli.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pth-services-"));
  cleanup.push(dir);
  return dir;
}

function fakeHealthManifest(port: number): HostServiceManifest {
  return {
    schemaVersion: 1,
    kind: "host",
    id: "fake-service",
    command: ["node", "-e", `require('http').createServer((req,res)=>{res.end('{"status":"ok"}')}).listen(${port})`],
    tokenEnv: "FAKE_SERVICE_TOKEN",
    healthUrl: `http://127.0.0.1:${port}/health`,
    readyTimeoutMs: 5_000,
    stopGraceMs: 1_000,
  };
}

describe("pth services：host 进程监督器", () => {
  it("实际 service.json 声明合法（local-lean/local-u8 host）", () => {
    for (const id of ["local-lean", "local-u8"]) {
      const manifest = validateServiceManifest(
        JSON.parse(readFileSync(join(process.cwd(), "deploy/services", id, "service.json"), "utf8")),
      );
      expect(manifest).toMatchObject({ kind: "host", id, healthUrl: expect.stringContaining("/health") });
      expect((manifest as HostServiceManifest).pathMapping?.execRootEnv).toBe("PTH_WORKSPACES_HOST");
    }
    const u8 = validateServiceManifest(
      JSON.parse(readFileSync(join(process.cwd(), "deploy/services/local-u8/service.json"), "utf8")),
    ) as HostServiceManifest;
    expect(u8.pathDirs).toEqual(["../../local-exec/u8"]);
    expect(() => validateServiceManifest({ schemaVersion: 1, kind: "host", id: "bad", command: [], tokenEnv: "T", healthUrl: "http://x/health" }))
      .toThrow(ServiceManifestError);
    expect(() => validateServiceManifest({ schemaVersion: 1, kind: "host", id: "bad", command: ["x"], tokenEnv: "T", healthUrl: "http://127.0.0.1:9999/health", pathDirs: ["/abs"] }))
      .toThrow(/pathDirs/);
  });

  it("registry 0600 往返 + 损坏 fail-closed", () => {
    const dir = tempDir();
    const path = join(dir, "services.json");
    saveServiceRegistry({ schemaVersion: 1, updatedAt: "", services: {} }, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const token = generateServiceToken();
    expect(token).toMatch(/^svc-/);
    const entry = {
      id: "local-lean", url: "http://127.0.0.1:8787", port: 8787, token,
      pid: 1234, startedAt: Date.now(), logFile: join(dir, "x.log"),
    };
    saveServiceRegistry({ schemaVersion: 1, updatedAt: "", services: { "local-lean": entry } }, path);
    expect(loadServiceRegistry(path).services["local-lean"]).toEqual(entry);
    writeFileSync(path, "{broken", "utf8");
    expect(() => loadServiceRegistry(path)).toThrow(/不可解析/);
  });

  it("token 解析：tokenEnv 环境变量非空优先 → registry 既有 → 新生成", () => {
    const entry = { id: "local-u8", url: "http://127.0.0.1:8788", port: 8788, token: "svc-existing", pid: 1, startedAt: Date.now(), logFile: "/tmp/x.log" };
    expect(resolveServiceToken(entry, "PTH_TEST_SVC_TOKEN", { PTH_TEST_SVC_TOKEN: "env-token-123" })).toBe("env-token-123");
    expect(resolveServiceToken(entry, "PTH_TEST_SVC_TOKEN", {})).toBe("svc-existing");
    expect(resolveServiceToken(entry, undefined)).toBe("svc-existing");
    expect(resolveServiceToken(undefined, "PTH_TEST_SVC_TOKEN", {})).toMatch(/^svc-/);
    expect(resolveServiceToken(undefined, undefined)).toMatch(/^svc-/);
  });

  it("up → status healthy → down（pid 防误杀只杀登记 pid）", async () => {
    const port = 18781 + Math.floor(Math.random() * 500);
    const manifest = fakeHealthManifest(port);
    const logFile = join(tempDir(), "fake.log");
    const result = await upHostService(manifest, { token: generateServiceToken(), logFile });
    try {
      expect(result.entry.pid).toBeGreaterThan(0);
      const status = await statusHostService(result.entry);
      expect(status).toMatchObject({ running: true, healthy: true });
    } finally {
      await downHostService(result.entry);
    }
    const status = await statusHostService(result.entry);
    expect(status.running).toBe(false);
  });

  it("pathDirs 前置注入子进程 PATH（local-u8 工具链可见性修复）", async () => {
    const dir = tempDir();
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const pathOut = join(dir, "path.txt");
    const port = 19381 + Math.floor(Math.random() * 500);
    const manifest: HostServiceManifest = {
      schemaVersion: 1,
      kind: "host",
      id: "path-dir-service",
      command: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(pathOut)}, process.env.PATH||''); require('http').createServer((req,res)=>res.end('{"status":"ok"}')).listen(${port})`],
      tokenEnv: "PATH_DIR_SERVICE_TOKEN",
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 5_000,
      stopGraceMs: 1_000,
    };
    const result = await upHostService(manifest, { token: generateServiceToken(), logFile: join(dir, "path-dir.log"), pathDirs: [binDir] });
    try {
      expect((await statusHostService(result.entry)).healthy).toBe(true);
      const seenPath = readFileSync(pathOut, "utf8");
      expect(seenPath.startsWith(`${binDir}${delimiter}`)).toBe(true);
    } finally {
      await downHostService(result.entry);
    }
  });

  it("端口占用预检：已有健康服务 → up 直接失败（不张冠李戴写 pid）", async () => {
    const port = 18901 + Math.floor(Math.random() * 300);
    const manifest = fakeHealthManifest(port);
    const first = await upHostService(manifest, { token: generateServiceToken(), logFile: join(tempDir(), "first.log") });
    try {
      await expect(upHostService(manifest, { token: generateServiceToken(), logFile: join(tempDir(), "second.log") }))
        .rejects.toThrow(/已有健康服务/);
    } finally {
      await downHostService(first.entry);
    }
  });

  it("服务注册表合并进 engine backend（url 改写 + token 直连 + pathMapping）", async () => {
    const token = generateServiceToken();
    const { registry } = buildExecutionBackendRegistry({
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
      serviceRegistry: {
        schemaVersion: 1,
        updatedAt: "",
        services: {
          "local-u8": {
            id: "local-u8", url: "http://127.0.0.1:8788", port: 8788, token,
            pid: 123, startedAt: Date.now(), logFile: "/tmp/u8.log",
            pathMapping: { hostRoot: "/data/workspaces", execRoot: "/host/workspaces" },
          },
        },
      },
    });
    const backend = registry.get("local-u8");
    expect(backend?.descriptor).toMatchObject({
      id: "local-u8",
      url: "http://host.docker.internal:8788",
      profile: "host",
      pathMapping: { hostRoot: "/data/workspaces", execRoot: "/host/workspaces" },
    });
    expect(defaultServiceRegistryPath()).toContain(".pi-triple");
  });
});
