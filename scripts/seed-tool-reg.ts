#!/usr/bin/env node
/**
 * seed-tool-reg.ts —— N14 P0 存量登记器 seed 脚本（2026-08-18，seed-wiki 同款幂等）。
 *
 * 从 PTC_TOOL_DEFS 生成全部 builtin tool-reg 条目（src/pth/tasking/tool-reg-builtin.ts
 * 单一生成源），写入 memory_entries：kind="tool-reg" · id=tool:<name> · status=official。
 * 幂等：content 相同跳过；内容变更则 upsert（version+1，meta 合并）。
 *
 * 用法（仓库根——tsx 跑 ts 依赖链，gen-project-map 同款）：
 *   DATABASE_URL=… npx tsx scripts/seed-tool-reg.ts            # 落库
 *   DATABASE_URL=… npx tsx scripts/seed-tool-reg.ts --check    # 只体检：DB ≡ 生成集？
 * 容器内（compose 网络——seed-wiki 同款）：
 *   docker cp scripts/seed-tool-reg.ts pi-platform-pi-platform-1:/app/scripts/
 *   docker exec pi-platform-pi-platform-1 npx tsx /app/scripts/seed-tool-reg.ts
 */

import pg from "pg";
import { buildBuiltinToolRegEntries, builtinToolRegRow, reconcileBuiltinToolRegs } from "../src/pth/tasking/tool-reg-builtin.ts";

const checkOnly = process.argv.includes("--check");
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("缺少 DATABASE_URL（compose 已配）");
  process.exit(1);
}

const { specs, implicitFullFaceRoles: fullFace } = buildBuiltinToolRegEntries();

// 生成侧自体检（双写对账第一半场——第二半场是与 DB 对比）
const reconcile = reconcileBuiltinToolRegs(specs);
if (!reconcile.ok) {
  console.error("生成集对账失败（先修代码侧漂移再 seed）：\n - " + reconcile.issues.join("\n - "));
  process.exit(1);
}
console.log(`生成 ${specs.length} 条 builtin tool-reg 条目（隐式全面角色：${fullFace.join("/")}）`);

const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });

if (checkOnly) {
  const { rows } = await pool.query("SELECT id, content, status FROM memory_entries WHERE kind = 'tool-reg'");
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const expected = new Map(specs.map((s) => [`tool:${s.name}`, builtinToolRegRow(s, fullFace)]));
  const issues: string[] = [];
  for (const [id, row] of expected) {
    const db = byId.get(id);
    if (!db) { issues.push(`DB 缺条目：${id}`); continue; }
    if (db.content !== row.content) issues.push(`DB 条目漂移：${id}（重跑本脚本对齐）`);
    if (db.status !== "official") issues.push(`DB 条目状态异常：${id} status=${db.status}`);
  }
  for (const id of byId.keys()) {
    if (!expected.has(id)) issues.push(`DB 多条目：${id}（生成集已无——按治理流退役）`);
  }
  await pool.end();
  if (issues.length > 0) {
    console.error("DB ⇄ 生成集对账不通过：\n - " + issues.join("\n - "));
    process.exit(1);
  }
  console.log(`--check 通过：DB ${rows.length} 条 ≡ 生成集 ${expected.size} 条`);
  process.exit(0);
}

let written = 0;
let skipped = 0;
let failed = 0;
for (const spec of specs) {
  const row = builtinToolRegRow(spec, fullFace);
  try {
    const { rows } = await pool.query("SELECT content FROM memory_entries WHERE id = $1", [row.id]);
    if (rows[0] && rows[0].content === row.content) {
      skipped++;
      continue;
    }
    await pool.query(
      ["INSERT INTO memory_entries (id, kind, anchors, content, status, meta, updated_at)",
       "VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, now())",
       "ON CONFLICT (id) DO UPDATE SET",
       "  kind = EXCLUDED.kind,",
       "  anchors = EXCLUDED.anchors,",
       "  content = EXCLUDED.content,",
       "  status = EXCLUDED.status,",
       "  meta = memory_entries.meta || EXCLUDED.meta,",
       "  version = memory_entries.version + 1,",
       "  updated_at = now()"].join(" "),
      [
        row.id,
        row.kind,
        JSON.stringify(row.anchors),
        row.content,
        row.status,
        JSON.stringify({ ...row.meta, seededAt: Date.now() }),
      ],
    );
    written++;
  } catch (e) {
    failed++;
    console.error("写入失败 " + row.id + ": " + (e instanceof Error ? e.message : String(e)));
  }
}
await pool.end();
console.log(`完成：写入 ${written} · 跳过（未变更） ${skipped} · 失败 ${failed} · 共 ${specs.length}`);
if (failed > 0) process.exit(1);
