#!/usr/bin/env node
/**
 * scripts/build-docs-manifest.ts —— 生成 docs/ 全量分类清单（第一阶段：先清单后搬迁）。
 *
 * 运行：npm run docs:manifest
 * 产物：docs/docs-manifest.json（每份文档的 category/product/status + 代码运行时规划）。
 * 分类只做标注，不移动任何文件；物理搬迁必须在链接校验通过后另行执行。
 */

import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsRoot = join(root, "docs");
const outFile = join(docsRoot, "docs-manifest.json");

export type DocCategory =
  | "index"
  | "guides"
  | "designs"
  | "contracts"
  | "reports"
  | "envelopes"
  | "decisions"
  | "operations"
  | "releases"
  | "archive"
  | "assets"
  | "artifacts";

export type DocStatus = "active" | "reference" | "historical";

export type DocProduct = "shared" | "ptl" | "pth";

export interface DocEntry {
  path: string;
  category: DocCategory;
  product: DocProduct;
  status: DocStatus;
}

export interface CodeRuntimeEntry {
  path: string;
  runtime: "deps" | "host" | "container" | "dual" | "config";
  note: string;
}

const PTH_GUIDES = new Set([
  "agent-construction.md", "api.md", "architecture.md", "concepts.md", "configuration.md",
  "console-protocol.md", "container-runtime-adapter-protocol.md", "deployment.md",
  "development.md", "extensions-dev.md", "framework-contracts.md", "kernel.md",
  "module-ownership.md", "orchestration.md", "pth-api-protocol.md",
  "sandbox-security-operations.md", "trigger-runtime.md",
]);

const PTH_OPERATIONS = new Set([
  "backlog-priority.md", "parallel-lanes.md", "design-tensions-adjudication.md",
]);

const HISTORICAL_DESIGNS = /^n(1[4-9]|2[0-4])-/;
const CONTRACT_RE = /^(n24-f[1-5]|n27-r[1-6]|n28-task[1-7]|n28-lane-contract-rulings)-/;

export function classifyDocsFile(file: string): DocEntry {
  const rel = relative(docsRoot, file).split("\\").join("/");
  const base = rel.split("/").pop()!;
  const parts = rel.split("/");

  if (rel === "README.md") return { path: `docs/${rel}`, category: "index", product: "shared", status: "active" };
  if (rel === "product-shape.md" || rel === "container-dev-skill.md" || rel === "code-organization-plan.md") {
    return { path: `docs/${rel}`, category: "guides", product: "shared", status: "active" };
  }
  if (parts[0] === "images") return { path: `docs/${rel}`, category: "assets", product: "shared", status: "active" };
  if (parts[0] === "adr") return { path: `docs/${rel}`, category: "decisions", product: "shared", status: "active" };
  if (parts[0] === "releases") return { path: `docs/${rel}`, category: "releases", product: "shared", status: "historical" };
  if (parts[0] === "research") return { path: `docs/${rel}`, category: "archive", product: "shared", status: "historical" };
  if (parts[0] === "superpowers") {
    if (base === "sdd-execution-sop.md" || parts[1] === "runbooks") {
      return { path: `docs/${rel}`, category: "operations", product: "shared", status: "reference" };
    }
    return { path: `docs/${rel}`, category: "archive", product: parts[2]?.startsWith("ptl") || base.includes("ptl") ? "ptl" : "pth", status: "historical" };
  }
  if (parts[0] === "ptl") {
    if (parts[1] === "templates") return { path: `docs/${rel}`, category: "assets", product: "ptl", status: "active" };
    return { path: `docs/${rel}`, category: "guides", product: "ptl", status: "active" };
  }
  if (parts[0] !== "pth") return { path: `docs/${rel}`, category: "archive", product: "shared", status: "historical" };

  if (base.endsWith(".json")) {
    if (base === "pth-console-openapi.json") return { path: `docs/${rel}`, category: "artifacts", product: "pth", status: "active" };
    if (base.includes("envelope") || base.includes("acceptance")) return { path: `docs/${rel}`, category: "envelopes", product: "pth", status: "active" };
    if (base === "tension-decisions.json") return { path: `docs/${rel}`, category: "decisions", product: "pth", status: "reference" };
    return { path: `docs/${rel}`, category: "artifacts", product: "pth", status: "historical" };
  }

  if (PTH_GUIDES.has(base)) return { path: `docs/${rel}`, category: "guides", product: "pth", status: "active" };
  if (PTH_OPERATIONS.has(base)) return { path: `docs/${rel}`, category: "operations", product: "pth", status: "reference" };
  if (CONTRACT_RE.test(base)) return { path: `docs/${rel}`, category: "contracts", product: "pth", status: "reference" };
  if (base.includes("report") || base.includes("feedback") || base.includes("audit")
    || base.includes("analysis") || base.includes("acceptance") || base.includes("evaluation")) {
    return { path: `docs/${rel}`, category: "reports", product: "pth", status: "historical" };
  }
  if (base.includes("structure-baseline")) return { path: `docs/${rel}`, category: "artifacts", product: "pth", status: "historical" };
  if (base.endsWith("-design.md") || base.endsWith("-plan.md") || base.endsWith("-design-and-implementation.md")) {
    const status: DocStatus = HISTORICAL_DESIGNS.test(base) ? "historical" : "reference";
    return { path: `docs/${rel}`, category: "designs", product: "pth", status };
  }
  return { path: `docs/${rel}`, category: "designs", product: "pth", status: HISTORICAL_DESIGNS.test(base) ? "historical" : "reference" };
}

export const CODE_RUNTIME_MAP: CodeRuntimeEntry[] = [
  { path: "packages/shared/", runtime: "deps", note: "共享配置/路径/版本等基础能力（PTL/PTH 共用）" },
  { path: "packages/infra/", runtime: "deps", note: "模型路由/日志/平台/sdk 适配/容器运行时协议（共用基础包）" },
  { path: "packages/pth-memory/", runtime: "deps", note: "PTH 记忆库（进程内使用，非独立服务）" },
  { path: "packages/mailbox/", runtime: "deps", note: "跨会话邮箱（库，非独立服务）" },
  { path: "packages/framework/", runtime: "host", note: "PTL CLI/TUI/容器运维命令，宿主机执行" },
  { path: "scripts/", runtime: "host", note: "宿主机工具脚本（pth/pth CLI 入口、验收/维护脚本）" },
  { path: "packages/dev-container/", runtime: "host", note: "宿主机控制 dev 容器（start/mount/verify）" },
  { path: "src/pth/", runtime: "dual", note: "PTH 主服务：容器内生产运行；宿主机 node dist/pth/main.js 试运行/tsx dev" },
  { path: "packages/pth-console/", runtime: "dual", note: "PTH CLI/loopback Web：宿主机交互为主；server 组件可随部署进容器" },
  { path: "deploy/docker-monitor/", runtime: "dual", note: "本机监控服务：宿主机 MONITOR_HOST 直跑，也可入容器采集" },
  { path: "packages/pth-sandbox/", runtime: "container", note: "隔离执行容器（kernel 池 + exec API）" },
  { path: "toolstore/", runtime: "container", note: "PTH 容器内扩展代码库/策略/命名编译单元" },
  { path: "extensions/", runtime: "container", note: "PTH 容器内扩展源码" },
  { path: "deploy/Dockerfile*", runtime: "container", note: "容器镜像构建（主服务/sandbox/dev/jupyter）" },
  { path: "deploy/docker-compose*.yaml", runtime: "config", note: "compose 拓扑" },
  { path: "deploy/*.json", runtime: "config", note: "runtime lock 与部署描述" },
  { path: "deploy/.env.pth.secrets*", runtime: "config", note: "密钥（gitignore 的 secrets + 提交的 example）" },
  { path: "config/", runtime: "config", note: "pi 模板/配置面" },
  { path: "tsconfig*.json · package.json · package-lock.json", runtime: "config", note: "workspace/构建配置" },
];

export function collectDocsEntries(): DocEntry[] {
  const out: DocEntry[] = [];
  walk(docsRoot, (file) => {
    if (file === outFile) return;
    out.push(classifyDocsFile(file));
  });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function walk(dir: string, onFile: (file: string) => void): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, onFile);
    else if (/\.(md|json|txt)$/.test(name)) onFile(full);
  }
}

const invokedDirectly = process.argv[1]?.endsWith("build-docs-manifest.ts") ?? false;
if (invokedDirectly) {
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    taxonomy: {
      docs: ["index", "guides", "designs", "contracts", "reports", "envelopes", "decisions", "operations", "releases", "archive", "assets", "artifacts"],
      runtime: ["deps", "host", "container", "dual", "config"],
    },
    docs: collectDocsEntries(),
    codeRuntime: CODE_RUNTIME_MAP,
  };
  writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`docs-manifest: ${manifest.docs.length} docs · ${manifest.codeRuntime.length} code entries → ${relative(root, outFile)}`);
}
