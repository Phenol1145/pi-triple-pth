/**
 * scripts/check-duplication.ts —— 跨文件重复代码块扫描（审计辅助）。
 *
 * 扫描 src/ 与 packages 下各包的 .ts 源码（排除 node_modules/dist/test/data），
 * 报告跨文件重复的 6 行代码块。当前作为非阻断审计；后续可加阈值门禁。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_ROOTS = ["src", "packages"];
const BLOCK_SIZE = 6;
const IGNORED_PARTS = ["node_modules", "dist", "test", "__tests__", "/data/", "discipline-catalog-data"];

function isTsFile(name: string): boolean {
  return name.endsWith(".ts");
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED_PARTS.includes(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (st.isFile() && isTsFile(entry)) {
      out.push(full);
    }
  }
  return out;
}

function normalizeLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
    out.push(line.replace(/\s+/g, " "));
  }
  return out;
}

interface Location {
  file: string;
  line: number;
}

interface RepeatedBlock {
  occurrences: number;
  files: Set<string>;
  key: string[];
  locations: Location[];
}

function main(): void {
  const files = SCAN_ROOTS.flatMap((root) => collectTsFiles(join(ROOT, root)));
  const map = new Map<string, RepeatedBlock>();

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const lines = normalizeLines(text);
    for (let i = 0; i + BLOCK_SIZE <= lines.length; i += 1) {
      const key = lines.slice(i, i + BLOCK_SIZE);
      if (new Set(key).size < 3) continue;
      const id = JSON.stringify(key);
      let block = map.get(id);
      if (!block) {
        block = { occurrences: 0, files: new Set(), key, locations: [] };
        map.set(id, block);
      }
      block.occurrences += 1;
      block.files.add(file);
      block.locations.push({ file, line: i + 1 });
    }
  }

  const hits = [...map.values()].filter(
    (b) => b.files.size > 1 && ![...b.files].some((f) => IGNORED_PARTS.some((part) => f.includes(part))),
  );
  hits.sort((a, b) => b.occurrences - a.occurrences);

  console.log(`── duplication 报告（${files.length} files · block=${BLOCK_SIZE}）──`);
  console.log(`跨文件重复块：${hits.length}`);
  for (const hit of hits.slice(0, 20)) {
    const sample = hit.locations[0]!;
    console.log(`- ${hit.occurrences} 处 / ${hit.files.size} 文件  ${relative(ROOT, sample.file)}:${sample.line}`);
    for (const line of hit.key.slice(0, 4)) {
      console.log(`    ${line}`);
    }
  }
  console.log("✅ duplication 扫描完成（非阻断）");
}

main();
