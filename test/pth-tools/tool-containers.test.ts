import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { HttpExecutionClient, EXECUTION_WIRE } from "@away_from/shared/execution";
import { hasAllDomainDigests, pinToolManifestDigest, validateToolManifest, ToolManifestError } from "../../src/pth/tools/tool-manifest.js";
import {
  defaultToolRegistryPath,
  ensureDomainTokens,
  loadToolRegistry,
  saveToolRegistry,
  upsertToolRegistryEntry,
} from "../../src/pth/tools/tool-registry.js";
import {
  parseToolComposePs,
  renderToolCompose,
  type DockerResult,
  type ToolComposeInput,
} from "../../src/pth/tools/tool-compose.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pth-tools-"));
  cleanup.push(dir);
  return dir;
}

const REAL_MANIFEST = JSON.parse(readFileSync(join(process.cwd(), "deploy/tool-containers/tool-manifest.json"), "utf8")) as unknown;

function composeInput(overrides: Partial<ToolComposeInput> = {}): ToolComposeInput {
  return {
    manifest: validateToolManifest(REAL_MANIFEST),
    localBuild: true,
    tokens: {
      compiled: { hostToken: "host-token-compiled-000", engineToken: "engine-token-compiled-000" },
      network: { hostToken: "host-token-network-0000", engineToken: "engine-token-network-0000" },
      secrets: { hostToken: "host-token-secrets-00000" },
    },
    toolsDir: tempDir(),
    ...overrides,
  };
}

describe("T2：tool-manifest 规范（T0 fail-closed）", () => {
  it("实际 manifest 合法：域信任边界/engineVisible/secrets 约束", () => {
    const manifest = validateToolManifest(REAL_MANIFEST);
    expect(manifest.domains.compiled?.network).toBe("internal");
    expect(manifest.domains.network?.engineVisible).toBe(true);
    expect(manifest.domains.secrets?.engineVisible).toBe(false);
    for (const tool of manifest.domains.secrets?.tools ?? []) {
      expect(tool.hostOnly).toBe(true);
      expect(tool.modes).toContain("interactive");
    }
    expect(manifest.domains.compiled?.tools.map((t) => t.name)).toContain("bf");
  });

  it("hasAllDomainDigests：全钉版 true；任一空 digest false（B7 默认策略输入）", () => {
    expect(hasAllDomainDigests(validateToolManifest(REAL_MANIFEST))).toBe(true);
    const noDigest = JSON.parse(JSON.stringify(REAL_MANIFEST)) as { domains: Record<string, { digest?: string }> };
    noDigest.domains.compiled!.digest = "";
    expect(hasAllDomainDigests(validateToolManifest(noDigest))).toBe(false);
  });

  it("非法 manifest fail-closed：未知域 / digest / 域网络漂移 / 重名工具 / secrets 越界", () => {
    const bad = (patch: (m: any) => void) => {
      const copy = JSON.parse(JSON.stringify(REAL_MANIFEST));
      patch(copy);
      return () => validateToolManifest(copy);
    };
    expect(bad((m) => { m.domains.interactive = {}; })).toThrow(ToolManifestError);
    expect(bad((m) => { m.domains.compiled.digest = "sha256:abc"; })).toThrow(/digest/);
    expect(bad((m) => { m.domains.compiled.network = "default"; })).toThrow(/network must be internal/);
    expect(bad((m) => { m.domains.network.tools.push({ ...m.domains.network.tools[0], name: "bf" }); })).toThrow(/duplicate tool/);
    expect(bad((m) => { m.domains.secrets.tools[0].engineVisible = true; })).toThrow(/secrets tool/);
    expect(bad((m) => { m.domains.compiled.tools[0].modes = ["interactive"]; })).toThrow(/interactive/);
  });
});

describe("T2：回环注册表（0600 + token 不迁移）", () => {
  it("save/load 往返 + 0600 + 损坏 fail-closed", () => {
    const dir = tempDir();
    const path = join(dir, "tool-containers.json");
    let file = loadToolRegistry(path);
    expect(file.tools).toEqual({});
    file = ensureDomainTokens(file, ["compiled", "network", "secrets"]);
    expect(file.domainTokens.compiled?.engineToken).toMatch(/^tool-/);
    expect(file.domainTokens.secrets?.engineToken).toBeUndefined();
    saveToolRegistry(file, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const loaded = loadToolRegistry(path);
    expect(loaded.domainTokens.compiled).toEqual(file.domainTokens.compiled);

    writeFileSync(path, "{broken", "utf8");
    expect(() => loadToolRegistry(path)).toThrow(/不可解析/);
  });

  it("upsert 工具条目按 tool 键幂等", () => {
    const file = upsertToolRegistryEntry(
      { schemaVersion: 1, updatedAt: "", tools: {}, domainTokens: {} },
      { tool: "bf", domain: "compiled", backendId: "tools-compiled", url: "http://127.0.0.1:54321", port: 54321, token: "tool-token-1234567890" },
    );
    expect(file.tools["bf"]).toMatchObject({ port: 54321, backendId: "tools-compiled" });
    expect(defaultToolRegistryPath()).toContain(".pi-triple");
  });
});

describe("T2：compose 生成（动态端口 + 域网络 + 认证面）", () => {
  it("localBuild 渲染：compiled internal / gateway 边车 / secrets 无 ENGINE_TOKEN / 动态端口", () => {
    const yaml = renderToolCompose(composeInput());
    expect(yaml).toContain('name: "pi-triple-tools"');
    expect(yaml).toContain('"127.0.0.1::8080"');
    expect(yaml).toContain("tools-compiled:\n    internal: true");
    expect(yaml).toContain("tools-compiled-gateway:");
    expect(yaml).toContain("tools-loopback: {}");
    expect(yaml).toContain("ENGINE_TOKEN");
    const secretsSection = yaml.slice(yaml.indexOf("tools-secrets:"));
    expect(secretsSection).not.toContain("ENGINE_TOKEN");
    expect(secretsSection).toContain("HOST_TOKEN");
  });

  it("pinToolManifestDigest：digest 强校验 + 域缺失 fail-closed", () => {
    const manifest = validateToolManifest(REAL_MANIFEST);
    const digest = "sha256:" + "a".repeat(64);
    const pinned = pinToolManifestDigest(manifest, "compiled", digest);
    expect(pinned.domains.compiled?.digest).toBe(digest);
    expect(() => pinToolManifestDigest(manifest, "compiled", "sha256:bad")).toThrow(ToolManifestError);
    expect(() => pinToolManifestDigest(manifest, "ghost" as never, digest)).toThrow(ToolManifestError);
  });

  it("非本地构建必须 digest 钉版；ps JSON 端口解析", () => {
    // GHCR release 后 REAL_MANIFEST 已钉版——用去掉 digest 的副本验证 fail-closed
    const noDigest = JSON.parse(JSON.stringify(REAL_MANIFEST));
    for (const domain of Object.keys((noDigest as { domains: Record<string, { digest?: string }> }).domains)) {
      (noDigest as { domains: Record<string, { digest?: string }> }).domains[domain]!.digest = "";
    }
    expect(() => renderToolCompose(composeInput({ manifest: validateToolManifest(noDigest), localBuild: false }))).toThrow(/必须钉 digest/);
    const withDigest = JSON.parse(JSON.stringify(REAL_MANIFEST));
    withDigest.domains.compiled.digest = "sha256:" + "a".repeat(64);
    withDigest.domains.network.digest = "sha256:" + "b".repeat(64);
    withDigest.domains.secrets.digest = "sha256:" + "c".repeat(64);
    const yaml = renderToolCompose(composeInput({ manifest: validateToolManifest(withDigest), localBuild: false }));
    expect(yaml).toContain("@sha256:" + "a".repeat(64));

    const services = parseToolComposePs(JSON.stringify([
      { Name: "tools-compiled", Image: "x", State: "running", Publishers: [{ TargetPort: 8080, PublishedPort: 54321, URL: "127.0.0.1" }] },
    ]));
    expect(services[0]).toMatchObject({ name: "tools-compiled", publishers: [{ publishedPort: 54321 }] });
  });
});

describe("T2：tool-server（白名单 + execution/v1.1）", () => {
  it("同步执行白名单工具；白名单外拒绝；health/capabilities 正常", async () => {
    const dir = tempDir();
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-08-22T00:00:00.000Z",
      domains: {
        compiled: {
          image: "x", network: "internal", engineVisible: true,
          tools: [
            { name: "node-echo", argv: ["node", "-e", "console.log('tool-ok')"], engineVisible: true, hostOnly: false, modes: ["sync", "stream"] },
          ],
        },
      },
    }), "utf8");

    const port = 18871;
    const child = spawn(process.execPath, [join(process.cwd(), "deploy/tool-containers/server/tool-server.mjs")], {
      env: { ...process.env, TOOL_DOMAIN: "compiled", HOST_TOKEN: "", ENGINE_TOKEN: "engine-token-tool-server", PORT: String(port), TOOL_MANIFEST_PATH: manifestPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanup.push(dir);
    const waitFor = async (): Promise<void> => {
      for (let i = 0; i < 50; i += 1) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          if (res.ok) return;
        } catch { /* 重试 */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("tool-server 未就绪");
    };
    try {
      await waitFor();
      const client = new HttpExecutionClient({ baseUrl: `http://127.0.0.1:${port}`, token: "engine-token-tool-server" });
      const ok = await client.execute({ cmd: ["node", "-e", "console.log('tool-ok')"], mode: "sync" });
      expect(ok.stdout.trim()).toBe("tool-ok");

      await expect(client.execute({ cmd: ["node", "-e", "console.log('evil')"], mode: "sync" }))
        .rejects.toMatchObject({ code: EXECUTION_WIRE.errorCodes.invalidRequest });
    } finally {
      child.kill("SIGKILL");
    }
  });
});
