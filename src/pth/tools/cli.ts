/**
 * tools/cli.ts —— `pth tools` / `pth services` 命令实现（T2）。
 *
 * 生命周期：build / up / down / status / logs / list / run / verify / debug；
 * pull / release 面向 GHCR digest 钉版（release 需 registry push 权限，见 topology §5.5）。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HttpExecutionClient,
  resolveExecutionMode,
  type ExecutionRequest,
} from "@away_from/shared/execution";
import { hasAllDomainDigests, pinToolManifestDigest, validateToolManifest, type ToolDefinition, type ToolContainerDomain, type ToolManifestFile } from "./tool-manifest.js";
import {
  defaultToolRegistryPath,
  ensureDomainTokens,
  generateToolToken,
  loadToolRegistry,
  saveToolRegistry,
  type ToolRegistryFile,
} from "./tool-registry.js";
import { pthConfig } from "../config/index.js";
import {
  realDockerRun,
  renderToolCompose,
  toolComposeCommand,
  toolComposeDown,
  toolComposePs,
  toolComposeUp,
  type ToolComposeInput,
} from "./tool-compose.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TOOLS_DIR = resolve(pthConfig().str("PTH_TOOL_TOOLS_DIR") || join(REPO_ROOT, "deploy", "tool-containers"));

function manifestPath(): string {
  return join(TOOLS_DIR, "tool-manifest.json");
}

function loadManifest(): ToolManifestFile {
  return validateToolManifest(JSON.parse(readFileSync(manifestPath(), "utf8")));
}

function registryPath(): string {
  return defaultToolRegistryPath();
}

function domainFor(manifest: ToolManifestFile, toolName: string): { domain: ToolContainerDomain; tool: ToolDefinition } | undefined {
  for (const domain of Object.keys(manifest.domains) as ToolContainerDomain[]) {
    const tool = manifest.domains[domain]?.tools.find((t) => t.name === toolName);
    if (tool) return { domain, tool };
  }
  return undefined;
}

function composeInput(manifest: ToolManifestFile, registry: ToolRegistryFile, localBuild: boolean): ToolComposeInput {
  const domains = Object.keys(manifest.domains) as ToolContainerDomain[];
  const tokens: ToolComposeInput["tokens"] = {};
  for (const domain of domains) {
    tokens[domain] = registry.domainTokens[domain] ?? { hostToken: generateToolToken() };
  }
  return { manifest, localBuild, tokens, toolsDir: TOOLS_DIR };
}

async function refreshRegistryAfterUp(manifest: ToolManifestFile, registryFile: ToolRegistryFile): Promise<void> {
  const { services } = await toolComposePs(composeInput(manifest, registryFile, true));
  let file = registryFile;
  for (const domain of Object.keys(manifest.domains) as ToolContainerDomain[]) {
    const domainManifest = manifest.domains[domain]!;
    const serviceName = domain === "compiled" ? "tools-compiled-gateway" : `tools-${domain}`;
    const service = services.find((s) => s.name.includes(serviceName));
    const publisher = service?.publishers.find((p) => p.targetPort === 8080);
    if (!publisher) continue;
    const tokens = file.domainTokens[domain];
    const token = domain === "secrets" ? tokens?.hostToken : (tokens?.engineToken ?? tokens?.hostToken);
    if (!token) continue;
    for (const tool of domainManifest.tools) {
      file = {
        ...file,
        tools: {
          ...file.tools,
          [tool.name]: {
            tool: tool.name,
            domain,
            backendId: `tools-${domain}`,
            url: `http://127.0.0.1:${publisher.publishedPort}`,
            port: publisher.publishedPort,
            token,
            updatedAt: new Date().toISOString(),
          },
        },
      };
    }
  }
  saveToolRegistry(file, registryPath());
}

function printTable(rows: string[][]): void {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  for (const row of rows) {
    console.log(row.map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0)).join("  ").trimEnd());
  }
}

function flagsMap(args: string[]): { flags: Set<string>; positional: string[] } {
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const item of args) {
    if (item.startsWith("--")) flags.add(item);
    else positional.push(item);
  }
  return { flags, positional };
}

async function toolsList(manifest: ToolManifestFile): Promise<void> {
  const registry = loadToolRegistry(registryPath());
  const rows = [["TOOL", "DOMAIN", "MODES", "ENGINE", "HOST-ONLY", "REGISTRY"]];
  for (const domain of Object.keys(manifest.domains) as ToolContainerDomain[]) {
    for (const tool of manifest.domains[domain]?.tools ?? []) {
      rows.push([
        tool.name,
        domain,
        tool.modes.join(","),
        String(tool.engineVisible),
        String(tool.hostOnly),
        registry.tools[tool.name] ? registry.tools[tool.name]!.url : "not-up",
      ]);
    }
  }
  printTable(rows);
}

async function toolsUp(manifest: ToolManifestFile, args: string[]): Promise<void> {
  const { flags } = flagsMap(args);
  // B7（2026-08-22）：默认策略 = 全部域已钉 digest → 用 GHCR 钉版；否则本地构建。
  // --build 强制本地重建；--pull 强制拉取钉版（未钉版时 fail-closed）。
  const localBuild = flags.has("--build") ? true : flags.has("--pull") ? false : !hasAllDomainDigests(manifest);
  let registry = loadToolRegistry(registryPath());
  registry = ensureDomainTokens(registry, Object.keys(manifest.domains) as ToolContainerDomain[]);
  saveToolRegistry(registry, registryPath());

  const result = flags.has("--build")
    ? await toolComposeCommand(composeInput(manifest, registry, true), ["up", "-d", "--build", "--wait", "--wait-timeout", "90"])
    : localBuild
      ? await toolComposeUp(composeInput(manifest, registry, true))
      : await toolComposeUp(composeInput(manifest, registry, false));
  if (result.code !== 0) {
    console.error(result.stderr || result.stdout || "pth tools up failed");
    process.exit(1);
  }
  await refreshRegistryAfterUp(manifest, registry);
  console.log("✅ tool containers up（回环注册表已刷新）");
  await toolsList(manifest);
}

async function toolsDown(manifest: ToolManifestFile): Promise<void> {
  const registry = loadToolRegistry(registryPath());
  const result = await toolComposeDown(composeInput(manifest, registry, true));
  if (result.code !== 0) {
    console.error(result.stderr || "pth tools down failed");
    process.exit(1);
  }
  const file: ToolRegistryFile = { ...registry, tools: {}, updatedAt: new Date().toISOString() };
  saveToolRegistry(file, registryPath());
  console.log("✅ tool containers down（注册表工具条目已清空，token 保留）");
}

async function toolsStatus(manifest: ToolManifestFile): Promise<void> {
  const registry = loadToolRegistry(registryPath());
  const { result, services } = await toolComposePs(composeInput(manifest, registry, true));
  if (result.code !== 0) {
    console.error(result.stderr || "pth tools status failed");
    return;
  }
  if (services.length === 0) console.log("tool containers：未运行（pth tools up）");
  else {
    const rows = [["SERVICE", "STATE", "IMAGE", "PUBLISHED"]];
    for (const service of services) {
      rows.push([
        service.name,
        service.state,
        service.image,
        service.publishers.map((p) => `127.0.0.1:${p.publishedPort}`).join(",") || "-",
      ]);
    }
    printTable(rows);
  }
}

async function toolsLogs(manifest: ToolManifestFile, args: string[]): Promise<void> {
  const registry = loadToolRegistry(registryPath());
  const service = args[0] && args[0] !== "--tail" && args[0] !== "--follow" ? args[0] : undefined;
  const dockerArgs = ["logs", ...(service ? [service] : [])];
  for (const item of args) if (item.startsWith("-")) dockerArgs.push(item);
  const result = await toolComposeCommand(composeInput(manifest, registry, true), dockerArgs);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0) process.exit(result.code);
}

/** tools run 专用参数解析：只有 --stream/--interactive 是本命令 flag，其余（--version 等）透传给工具。 */
function toolRunArgs(args: string[]): { flags: Set<string>; positional: string[] } {
  const known = new Set(["--stream", "--interactive"]);
  return {
    flags: new Set(args.filter((item) => known.has(item))),
    positional: args.filter((item) => !known.has(item)),
  };
}

async function resolveRunRequest(manifest: ToolManifestFile, args: string[]): Promise<{ request: ExecutionRequest; tool: ToolDefinition }> {
  const { flags, positional } = toolRunArgs(args);
  const toolName = positional[0];
  if (!toolName) throw new Error("用法: pth tools run <tool> [args…] [--stream] [--interactive]");
  const found = domainFor(manifest, toolName);
  if (!found) throw new Error(`未登记工具: ${toolName}（pth tools list）`);
  const entry = loadToolRegistry(registryPath()).tools[toolName];
  if (!entry) throw new Error(`${toolName} 未运行——先 pth tools up`);
  const argv = [...(found.tool.argv ?? [found.tool.name]), ...positional.slice(1)];
  const mode = flags.has("--interactive") ? "interactive" : flags.has("--stream") ? "stream" : "sync";
  if (!found.tool.modes.includes(mode)) throw new Error(`${toolName} 不支持 mode=${mode}（${found.tool.modes.join(",")}）`);
  return {
    request: { cmd: argv, mode },
    tool: found.tool,
  };
}

async function toolsRun(manifest: ToolManifestFile, args: string[]): Promise<void> {
  const { request } = await resolveRunRequest(manifest, args);
  const { positional } = toolRunArgs(args);
  const toolName = positional[0];
  const entry = loadToolRegistry(registryPath()).tools[toolName];
  const client = new HttpExecutionClient({ baseUrl: entry!.url, token: entry!.token });
  const mode = resolveExecutionMode(request);

  if (mode === "sync") {
    const result = await client.execute(request);
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
    return;
  }
  if (mode === "stream") {
    await client.stream(request, {
      onOutput: (event) => (event.stream === "stdout" ? process.stdout.write(event.data) : process.stderr.write(event.data)),
      onDone: (event) => { if (event.exitCode !== 0) process.exitCode = event.exitCode ?? 1; },
    });
    return;
  }
  const session = await client.interactive(request, {
    onOutput: (event) => (event.stream === "stdout" ? process.stdout.write(event.data) : process.stderr.write(event.data)),
  });
  process.stdin.on("data", (chunk) => session.writeStdin(chunk.toString("utf8")));
  const done = await session.done;
  if (done.exitCode !== 0) process.exit(done.exitCode ?? 1);
}

async function toolsVerify(manifest: ToolManifestFile): Promise<void> {
  const registry = loadToolRegistry(registryPath());
  const rows = [["TOOL", "HEALTH", "CAPABILITIES"]];
  let failures = 0;
  for (const domain of Object.keys(manifest.domains) as ToolContainerDomain[]) {
    for (const tool of manifest.domains[domain]?.tools ?? []) {
      const entry = registry.tools[tool.name];
      if (!entry) {
        rows.push([tool.name, "not-up", "-"]);
        failures += 1;
        continue;
      }
      try {
        const client = new HttpExecutionClient({ baseUrl: entry.url, token: entry.token });
        const caps = await client.getCapabilities();
        const modesOk = tool.modes.every((mode) => caps.modes?.[mode] === true);
        rows.push([tool.name, "ok", `${caps.version} ${tool.modes.join(",")}${modesOk ? "" : " ⚠"}`]);
        if (!modesOk) failures += 1;
      } catch (error) {
        rows.push([tool.name, "down", String(error instanceof Error ? error.message : error).slice(0, 60)]);
        failures += 1;
      }
    }
  }
  printTable(rows);
  if (failures > 0) process.exit(1);
  console.log("✅ all tools healthy");
}

async function toolsDebug(manifest: ToolManifestFile, args: string[]): Promise<void> {
  const registry = loadToolRegistry(registryPath());
  const [toolName, ...toolArgs] = args;
  if (!toolName) throw new Error("用法: pth tools debug <tool> -- <argv…>");
  const found = domainFor(manifest, toolName);
  if (!found) throw new Error(`未登记工具: ${toolName}`);
  const result = await toolComposeCommand(composeInput(manifest, registry, true), [
    "exec", "-T", `tools-${found.domain}`, ...(found.tool.argv ?? [found.tool.name]), ...toolArgs,
  ]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0) process.exit(result.code);
}

async function toolsBuild(manifest: ToolManifestFile): Promise<void> {
  const registry = ensureDomainTokens(loadToolRegistry(registryPath()), Object.keys(manifest.domains) as ToolContainerDomain[]);
  saveToolRegistry(registry, registryPath());
  const result = await toolComposeCommand(composeInput(manifest, registry, true), ["build"]);
  if (result.code !== 0) process.exit(result.code);
  console.log("✅ tool containers images built（local dev）");
}

async function toolsPull(manifest: ToolManifestFile): Promise<void> {
  const registry = loadToolRegistry(registryPath());
  const result = await toolComposeCommand(composeInput(manifest, registry, false), ["pull"]);
  if (result.code !== 0) process.exit(result.code);
  console.log("✅ digest 钉版镜像已拉取");
}

async function toolsRelease(manifest: ToolManifestFile, args: string[]): Promise<void> {
  const { flags } = flagsMap(args);
  if (flags.has("--help") || flags.has("-h")) {
    console.log("用法: pth tools release [--dry-run]   # GHCR 多架构 push + digest 钉版（需 docker login ghcr.io）");
    return;
  }
  const dryRun = flags.has("--dry-run");
  let next = manifest;
  for (const domain of Object.keys(manifest.domains) as ToolContainerDomain[]) {
    const entry = manifest.domains[domain]!;
    const tag = `${entry.image}:latest`;
    if (dryRun) {
      console.log(`${domain}: buildx --push ${tag}（dry-run）→ 之后 inspect digest 钉版`);
      continue;
    }
    // GHCR release：与 compose 本地构建同源（Dockerfile.tool + TOOL_DOMAIN build-arg）
    const push = await realDockerRun(["buildx", "build", "--platform", "linux/amd64,linux/arm64", "-f", join(TOOLS_DIR, "Dockerfile.tool"), "--build-arg", `TOOL_DOMAIN=${domain}`, "-t", tag, "--push", TOOLS_DIR]);
    if (push.code !== 0) {
      console.error(push.stderr || push.stdout || `release ${domain} push failed`);
      process.exit(1);
    }
    const inspect = await realDockerRun(["buildx", "imagetools", "inspect", tag, "--format", "{{.Manifest.Digest}}"]);
    if (inspect.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(inspect.stdout.trim())) {
      console.error(`${domain} digest 查询失败: ${inspect.stderr || inspect.stdout}`);
      process.exit(1);
    }
    next = pinToolManifestDigest(next, domain, inspect.stdout.trim());
    console.log(`${domain}: ${entry.image}@${inspect.stdout.trim()}`);
  }
  if (!dryRun) {
    writeFileSync(manifestPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log("✅ tool-manifest.json digest 已钉版");
  }
}

export async function toolsCommand(args: string[]): Promise<void> {
  const manifest = loadManifest();
  const sub = args[0] ?? "help";
  const rest = args.slice(1);
  switch (sub) {
    case "list": return toolsList(manifest);
    case "up": return toolsUp(manifest, rest);
    case "down": return toolsDown(manifest);
    case "status": return toolsStatus(manifest);
    case "logs": return toolsLogs(manifest, rest);
    case "run": return toolsRun(manifest, rest);
    case "verify": return toolsVerify(manifest);
    case "debug": return toolsDebug(manifest, rest);
    case "build": return toolsBuild(manifest);
    case "pull": return toolsPull(manifest);
    case "release": return toolsRelease(manifest, rest);
    default:
      console.log([
        "pth tools <list|up|down|status|logs|run|verify|debug|build|pull|release>",
        "  list                  列出 manifest 工具与注册表状态",
        "  up [--build] [--pull] 拉起独立 compose 项目并刷新 ~/.pi-triple/tool-containers.json",
        "  down                  停止并清空注册表工具条目（token 保留）",
        "  status|logs           容器状态 / 日志",
        "  run <tool> [args…]   经 execution 协议调用（--stream / --interactive）",
        "  verify                健康 + capabilities.modes 校验",
        "  debug <tool> -- argv 唯一 docker exec 逃生舱",
        "  build|pull            本地构建 / digest 镜像拉取",
        "  release               GHCR push + digest 钉版（需 registry 权限）",
      ].join("\n"));
  }
}

function servicesComposePath(): string {
  const servicesRoot = resolve(pthConfig().str("PTH_SERVICES_DIR") || join(REPO_ROOT, "deploy", "services"));
  return join(servicesRoot, "jupyter", "docker-compose.yaml");
}

export async function servicesCommand(args: string[]): Promise<void> {
  const composeFile = servicesComposePath();
  if (!existsSync(composeFile)) {
    console.log("pth services：jupyter 单容器双面部署物待 P5 落地（deploy/services/jupyter/）");
    return;
  }
  const sub = args[0] ?? "status";
  const project = pthConfig().str("PTH_SERVICES_PROJECT") || "pi-triple-services";
  const argv = ["compose", "-p", project, "-f", composeFile, sub === "status" ? "ps" : sub, ...args.slice(1)];
  const result = await realDockerRun(argv);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0) process.exit(result.code);
}

// renderToolCompose 再导出（测试契约用）
export { renderToolCompose, TOOLS_DIR };
