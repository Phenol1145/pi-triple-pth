/**
 * tools/tool-compose.ts —— tool containers 独立 compose 项目生成与生命周期执行（T2）。
 *
 * 只做 argv 数组调用 docker（沿用 dev-container 安全约定）；动态端口经
 * `docker compose ps --format json` 回读。compose 文件写到 deploy/tool-containers/ 下
 * 的 `.compose.generated.yaml`（gitignore）。
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ToolContainerDomain,
  ToolManifestFile,
} from "./tool-manifest.js";

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type DockerRun = (argv: string[]) => Promise<DockerResult>;

export function realDockerRun(argv: string[]): Promise<DockerResult> {
  return new Promise((resolve) => {
    execFile("docker", argv, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      const errno = error as NodeJS.ErrnoException;
      resolve({ code: typeof errno.code === "number" ? errno.code : 1, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

export interface ToolComposeInput {
  manifest: ToolManifestFile;
  /** true = 本地构建 dev 镜像（context=deploy/tool-containers）；false = 按 manifest image+digest 拉取 */
  localBuild: boolean;
  /** 每域启动 token：HOST_TOKEN 恒注入；ENGINE_TOKEN 仅 compiled/network */
  tokens: Partial<Record<ToolContainerDomain, { hostToken: string; engineToken?: string }>>;
  projectName?: string;
  /** deploy/tool-containers 目录（compose 文件写入处） */
  toolsDir: string;
}

export const TOOL_CONTAINER_INTERNAL_PORT = 8080;

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function imageFor(domain: ToolContainerDomain, domainImage: string, digest: string | undefined, localBuild: boolean): string {
  if (localBuild) return `pi-triple-pth-tools-${domain}:dev`;
  if (digest) return `${domainImage}@${digest}`;
  throw new Error(`${domain}: 非本地构建必须钉 digest（先 pth tools release）`);
}

export function renderToolCompose(input: ToolComposeInput): string {
  const domains = input.manifest.domains;
  const lines: string[] = [
    `name: ${yamlString(input.projectName ?? "pi-triple-tools")}`,
    "services:",
  ];
  for (const domain of Object.keys(domains) as ToolContainerDomain[]) {
    const entry = domains[domain];
    if (!entry) continue;
    const tokens = input.tokens[domain];
    const hostToken = tokens?.hostToken ?? "";
    const engineToken = tokens?.engineToken ?? "";
    const service = `tools-${domain}`;
    lines.push(`  ${service}:`);
    lines.push(`    image: ${yamlString(imageFor(domain, entry.image, entry.digest, input.localBuild))}`);
    if (input.localBuild) {
      lines.push(`    build:`);
      lines.push(`      context: .`);
      lines.push(`      dockerfile: Dockerfile.tool`);
      lines.push(`      args:`);
      lines.push(`        TOOL_DOMAIN: ${yamlString(domain)}`);
    }
    lines.push(`    command: ["node", "/opt/tool-server/tool-server.mjs"]`);
    lines.push(`    environment:`);
    lines.push(`      TOOL_DOMAIN: ${yamlString(domain)}`);
    lines.push(`      HOST_TOKEN: ${yamlString(hostToken)}`);
    if (domain !== "secrets" && engineToken) {
      lines.push(`      ENGINE_TOKEN: ${yamlString(engineToken)}`);
    }
    lines.push(`      PORT: "${TOOL_CONTAINER_INTERNAL_PORT}"`);
    lines.push(`    ports:`);
    lines.push(`      - "127.0.0.1::${TOOL_CONTAINER_INTERNAL_PORT}"`);
    lines.push(`    volumes:`);
    lines.push(`      - "./tool-manifest.json:/opt/tool-server/tool-manifest.json:ro"`);
    if (domain === "compiled") {
      lines.push(`    networks:`);
      lines.push(`      - tools-compiled`);
    }
    lines.push(`    healthcheck:`);
    lines.push(`      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:${TOOL_CONTAINER_INTERNAL_PORT}/health').then(r=>{if(!r.ok)process.exit(1)})"]`);
    lines.push(`      interval: 10s`);
    lines.push(`      timeout: 3s`);
    lines.push(`      retries: 3`);
    lines.push(`    restart: "no"`);
  }
  lines.push(`networks:`);
  lines.push(`  tools-compiled:`);
  lines.push(`    internal: true`);
  lines.push("");
  return lines.join("\n");
}

export function generatedComposePath(toolsDir: string): string {
  return join(toolsDir, ".compose.generated.yaml");
}

export function writeGeneratedCompose(input: ToolComposeInput): string {
  const path = generatedComposePath(input.toolsDir);
  mkdirSync(input.toolsDir, { recursive: true });
  writeFileSync(path, renderToolCompose(input), "utf8");
  return path;
}

export async function toolComposeCommand(
  input: ToolComposeInput,
  args: string[],
  run: DockerRun = realDockerRun,
): Promise<DockerResult> {
  const file = writeGeneratedCompose(input);
  const project = input.projectName ?? "pi-triple-tools";
  return run(["compose", "-p", project, "-f", file, ...args]);
}

export interface ToolComposePsService {
  name: string;
  image: string;
  state: string;
  publishers: Array<{ targetPort: number; publishedPort: number; url: string }>;
}

/** 回读动态端口：compose ps --format json 是逐行 JSON 对象（非数组）。 */
export function parseToolComposePs(stdout: string): ToolComposePsService[] {
  const rows: unknown[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) rows.push(...parsed);
      else rows.push(parsed);
    } catch { /* 跳过非 JSON 行 */ }
  }
  return (rows as Array<Record<string, unknown>>).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const publishers = Array.isArray(row.Publishers)
      ? (row.Publishers as Array<Record<string, unknown>>).flatMap((p) => {
          const target = Number(p?.TargetPort);
          const published = Number(p?.PublishedPort);
          const url = String(p?.URL ?? "");
          if (!Number.isInteger(target) || !Number.isInteger(published)) return [];
          return [{ targetPort: target, publishedPort: published, url }];
        })
      : [];
    return [{
      name: String(row.Name ?? ""),
      image: String(row.Image ?? ""),
      state: String(row.State ?? ""),
      publishers,
    }];
  });
}

export async function toolComposeUp(input: ToolComposeInput, run: DockerRun = realDockerRun): Promise<DockerResult> {
  return toolComposeCommand(input, ["up", "-d", "--wait", "--wait-timeout", "60"], run);
}

export async function toolComposeDown(input: ToolComposeInput, run: DockerRun = realDockerRun): Promise<DockerResult> {
  return toolComposeCommand(input, ["down"], run);
}

export async function toolComposePs(input: ToolComposeInput, run: DockerRun = realDockerRun): Promise<{ result: DockerResult; services: ToolComposePsService[] }> {
  const result = await toolComposeCommand(input, ["ps", "--format", "json"], run);
  return { result, services: result.code === 0 ? parseToolComposePs(result.stdout) : [] };
}

export function readToolManifestFile(path: string): string {
  return readFileSync(path, "utf8");
}
