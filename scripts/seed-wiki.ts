/**
 * seed-wiki.ts —— 百科记忆类型条目化 pipeline（2026-08-13 N1）。
 *
 * 读取 concepts.md §2 唯一词表（markdown 表格），把每个术语条目化写入 memory_entries：
 *   kind   = "pth-wiki"（百科——术语解释——0.8 锚点-原文：术语即锚点）
 *   status = "official"；anchors = ["pth-wiki", 术语]
 * 幂等：content 相同跳过（不递增版本）；内容变更则 upsert（version+1）。
 *
 * 运行（pi-platform 容器内——postgres 网络可达，DATABASE_URL 已配）：
 *   docker cp scripts/seed-wiki.ts pi-platform-pi-platform-1:/app/scripts/seed-wiki.ts
 *   docker cp docs/pth/concepts.md pi-platform-pi-platform-1:/app/scripts/concepts-seed.md
 *   docker exec pi-platform-pi-platform-1 node --experimental-strip-types /app/scripts/seed-wiki.ts /app/scripts/concepts-seed.md
 */

import { readFileSync } from "node:fs";
import pg from "pg";

const docPath = process.argv[2];
if (!docPath) {
  console.error("用法: node seed-wiki.ts <concepts.md>");
  process.exit(1);
}
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("缺少 DATABASE_URL（compose 已配）");
  process.exit(1);
}

const lines = readFileSync(docPath, "utf8").split("\n");

// 定位 §2 词表区间（## 2. 概念词表 —— ## 3. 概念关系）
const start = lines.findIndex((l) => /^## 2. /.test(l));
const end = lines.findIndex((l, i) => i > start && /^## 3. /.test(l));
if (start < 0 || end < 0) {
  console.error("未找到 §2 词表区间（## 2. … ## 3. …）");
  process.exit(1);
}

interface WikiTerm {
  id: string;
  term: string;
  marker: string;
  domain: string;
  coord: string;
  content: string;
}

const terms: WikiTerm[] = [];
let domain = "";
let coord = "";
let header: string[] = ["概念", "定义", "落点"];

for (const line of lines.slice(start, end)) {
  const h = line.match(/^### 域 ([A-F])：(.+?)(?:（理论坐标：(.+)）)?$/);
  if (h) {
    domain = "域 " + h[1] + " · " + h[2];
    coord = h[3] ?? "";
    continue;
  }
  if (!line.startsWith("| ")) continue;
  if (/^\| *:?-+/.test(line)) continue;   // 表分隔行 |---|
  const cells = line.slice(1).replace(/ \|$/, "").split(" | ").map((c) => c.trim());   // 剥行尾分隔符
  const raw = cells[0] ?? "";
  if (raw === "") continue;
  const marker = raw.match(/〔([^〕]*)〕/)?.[1] ?? "";
  const term = raw.replace(/\*\*/g, "").replace(/〔[^〕]*〕/g, "").trim();
  if (term === "") continue;
  if (["概念", "类型", "层"].includes(term)) {
    header = [term, ...cells.slice(1)];   // 记录表头以对齐列标签
    continue;
  }
  const parts: string[] = [];
  parts.push("术语：" + term);
  parts.push("域：" + domain);
  if (coord) parts.push("理论坐标：" + coord);
  for (let i = 0; i < cells.length - 1 && i < header.length - 1; i++) {
    const label = header[i + 1];
    const v = cells[i + 1];
    if (v && v !== "—") parts.push(label + "：" + v);
  }
  parts.push("锚点：术语即锚点（memory.query 按 anchors=['pth-wiki', 术语] 检索）");
  const markerText = marker === "旧" ? "旧体系已实装" : marker === "桥" ? "新方案已桥接" : marker === "新" ? "新方案未实装" : "未标注";
  parts.push("体系：〔" + (marker || "旧") + "〕" + markerText);
  parts.push("来源：concepts.md §2 唯一词表（体系分账 2026-08-13）");
  const dup = terms.find((t) => t.id === "wiki:" + term);
  if (dup) console.warn("重复术语 id：" + term + "（域 " + dup.domain + " 与 " + domain + " 同名——后写覆盖）");
  terms.push({ id: "wiki:" + term, term, marker, domain, coord, content: parts.join("\n") });
}

if (terms.length === 0) {
  console.error("§2 词表解析为空——检查表格格式");
  process.exit(1);
}
console.log("解析到 " + terms.length + " 个词表术语（" + domain + " 收尾）");

const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
let written = 0;
let skipped = 0;
let failed = 0;
for (const t of terms) {
  try {
    const { rows } = await pool.query("SELECT content FROM memory_entries WHERE id = $1", [t.id]);
    if (rows[0] && rows[0].content === t.content) {
      skipped++;
      continue;
    }
    await pool.query(
      ["INSERT INTO memory_entries (id, kind, anchors, content, status, meta, updated_at)",
       "VALUES ($1, 'pth-wiki', $2::jsonb, $3, 'official', $4::jsonb, now())",
       "ON CONFLICT (id) DO UPDATE SET",
       "  kind = EXCLUDED.kind,",
       "  anchors = EXCLUDED.anchors,",
       "  content = EXCLUDED.content,",
       "  status = EXCLUDED.status,",
       "  meta = memory_entries.meta || EXCLUDED.meta,",
       "  version = memory_entries.version + 1,",
       "  updated_at = now()"].join(" "),
      [
        t.id,
        JSON.stringify(["pth-wiki", t.term]),
        t.content,
        JSON.stringify({ seededAt: Date.now(), source: "concepts.md §2 唯一词表", seeder: "scripts/seed-wiki.ts" }),
      ],
    );
    written++;
  } catch (e) {
    failed++;
    console.error("写入失败 " + t.id + ": " + (e instanceof Error ? e.message : String(e)));
  }
}
await pool.end();
console.log("完成：写入 " + written + " · 跳过（未变更） " + skipped + " · 失败 " + failed + " · 共 " + terms.length);
if (failed > 0) process.exit(1);
