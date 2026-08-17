#!/usr/bin/env node
/**
 * import-mcp-bundle.ts —— N17 D1 MCP 拆解 bundle 导入脚本（2026-08-18）。
 *
 * 输入 = mcp-tool-bundle-v1 JSON bundle（已拆解重实现的 TS/JS 源码 + inputSchema）。
 * 输出 = 逐工具 tool-proposal draft（复用 N14 治理流——不直写 official；
 * 后续走既有 /api/v1/kernel/memory-admin/approve 批准）。
 *
 * 用法（仓库根——tsx 跑 ts 源，seed-tool-reg 同款）：
 *   DATABASE_URL=… npx tsx scripts/import-mcp-bundle.ts <bundle.json>          # 落库（draft 提案）
 *   DATABASE_URL=… npx tsx scripts/import-mcp-bundle.ts <bundle.json> --dry-run # 只校验+打印
 *
 * 错误处理：DATABASE_URL 缺省 fail-closed（seed-tool-reg 同款）；文件读取/JSON 解析/
 * bundle 校验失败 → 非零退出，不写库。
 */

import fs from "node:fs/promises";
import pg from "pg";
import { parseMcpBundle, mcpToolToSpec, importMcpTools } from "../src/pth/tasking/mcp-decompose.ts";
import { PgMemoryStore } from "../packages/pth-memory/src/memory-store-pg.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fileArg = args.find((a) => !a.startsWith("--"));

if (!fileArg) {
  console.error("用法: DATABASE_URL=… npx tsx scripts/import-mcp-bundle.ts <bundle.json> [--dry-run]");
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("缺少 DATABASE_URL（compose 已配）——fail-closed：不写库");
  process.exit(1);
}

let raw: unknown;
try {
  raw = JSON.parse(await fs.readFile(fileArg, "utf8"));
} catch (e) {
  console.error(`读取 bundle 失败 ${fileArg}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const parsed = parseMcpBundle(raw);
if (!parsed.ok) {
  console.error("bundle 校验失败：\n - " + parsed.errors.join("\n - "));
  process.exit(1);
}

const bundle = parsed.bundle;
console.log(`bundle 校验通过：server=${bundle.server} · tools=${bundle.tools.length}`);

for (const t of bundle.tools) {
  const converted = mcpToolToSpec(t, bundle.server);
  if (!converted.ok) {
    console.error(`tool ${t.name} spec 生成失败：${converted.error}`);
    process.exit(1);
  }
  const spec = converted.spec;
  const sourceLength = spec.executor.type === "program" ? spec.executor.source.length : 0;
  console.log(`- ${spec.name}`);
  console.log(`  anchor=${spec.description.anchor}`);
  console.log(`  whenToUse=${spec.description.whenToUse}`);
  console.log(`  effect=${spec.description.effect}`);
  console.log(`  parameters.required=[${spec.parameters.required.join(",")}] properties=[${Object.keys(spec.parameters.properties).join(",")}] source.length=${sourceLength}`);
}

if (dryRun) {
  console.log("--dry-run：只校验/打印，不写库");
  process.exit(0);
}

const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
let exitCode = 0;
try {
  const store = new PgMemoryStore(pool);
  const r = await importMcpTools(store, bundle);
  for (const ok of r.imported) {
    console.log(`imported ${ok.name} → ${ok.proposalId}`);
  }
  for (const f of r.failed) {
    console.error(`failed ${f.name}: ${f.error}`);
  }
  console.log(`完成：imported ${r.imported.length} · failed ${r.failed.length} · 共 ${bundle.tools.length}`);
  if (r.failed.length > 0) exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
