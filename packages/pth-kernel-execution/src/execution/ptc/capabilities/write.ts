/**
 * ptc/capabilities/write.ts —— TCE W1：write.* 能力对象。
 *
 * 从 agent-tools-registry.ts 抽出，行为逐字节保留。
 */

import type { AgentToolResult } from "../../agent-tools-registry.js";
import { readArtifact, resolveArtifact, truncate } from "./helpers.js";

export interface WriteCapabilityDeps {
  taskWorkspace?: string;
  toolstore?: import("@away_from/pth-kernel-interpreter").Toolstore;
}

export interface WriteCapability {
  create(input: { path: string; content: string; mode?: string }): Promise<AgentToolResult>;
  edit(input: { path: string; oldText: string; newText: string; mode?: string }): Promise<AgentToolResult>;
  read(input: { path: string; mode?: string }): Promise<AgentToolResult>;
  list(input?: { mode?: string }): Promise<AgentToolResult>;
  save(input: { path: string; name: string; mode?: string }): Promise<AgentToolResult>;
  section(input: { path: string; op: string; title?: string; target?: string; before?: string; mode?: string }): Promise<AgentToolResult>;
}

export function createWriteCapability(deps: WriteCapabilityDeps): WriteCapability {
  const { taskWorkspace, toolstore } = deps;

  return {
    async create(input) {
      const abs = resolveArtifact(taskWorkspace, input.path);
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, input.content, "utf-8");
      return { ok: true, value: { path: input.path }, stdout: `已创建文档 ${input.path}（${input.content.length} 字符）` };
    },

    async edit(input) {
      const abs = resolveArtifact(taskWorkspace, input.path);
      const content = await readArtifact(taskWorkspace, input.path);
      const oldText = input.oldText, newText = input.newText;
      const hits = content.split(oldText).length - 1;
      if (hits === 0) return { ok: false, error: `write.edit: oldText 未匹配（${input.path}）` };
      if (hits > 1) return { ok: false, error: `write.edit: oldText 匹配 ${hits} 处——需唯一（提供更多上下文）` };
      const { writeFile } = await import("node:fs/promises");
      await writeFile(abs, content.replace(oldText, newText), "utf-8");
      return { ok: true, value: { path: input.path }, stdout: `已编辑 ${input.path}（1 处替换）` };
    },

    async read(input) {
      const content = await readArtifact(taskWorkspace, input.path);
      const out = truncate(content, 6000);
      const hint = out.truncated ? `\n\n【截断提示】全文 ${content.length} 字符，仅显示前 6000——长文档可分段写（write.section op=split 拆章节）` : "";
      return { ok: true, value: { path: input.path, length: content.length, truncated: out.truncated }, stdout: out.text + hint };
    },

    async list() {
      const { readdir } = await import("node:fs/promises");
      const root = taskWorkspace ?? "/tmp";
      const docs: string[] = [];
      const walk = async (dir: string, prefix = ""): Promise<void> => {
        let entries: import("node:fs").Dirent[] = [];
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(`${dir}/${e.name}`, rel);
          else if (/\.(md|txt|rst|adoc)$/i.test(e.name)) docs.push(rel);
        }
      };
      await walk(root);
      return { ok: true, value: docs, stdout: docs.length ? docs.join("\n") : "（无文档）" };
    },

    async save(input) {
      if (!toolstore) return { ok: false, error: "write.save: toolstore 未配置" };
      const name = input.name;
      if (!/^[\w.-]+$/.test(name)) return { ok: false, error: `write.save: 非法文档名 "${name}"（限 [a-zA-Z0-9_.-]）` };
      const content = await readArtifact(taskWorkspace, input.path);
      await toolstore.writeText(`docs/${name}.md`, content);
      return { ok: true, value: { name }, stdout: `已保存文档 ${name}.md（${content.length} 字符——跨任务复用）` };
    },

    async section(input) {
      // 章节组织（非子空间——文档内结构操作）：op=list 列出标题结构；op=split 拆后段到新文件；op=reorder 重排章节
      const abs = resolveArtifact(taskWorkspace, input.path);
      const content = await readArtifact(taskWorkspace, input.path);
      const op = input.op || "list";
      // 标题定位（行级匹配——`# 一级` 至 `###### 六级`；统一辅助，split/reorder/before 同语义）
      const headingRe = /^#{1,6}\s+.+$/gm;
      const matches = [...content.matchAll(headingRe)];
      const findHeading = (title: string): number => matches.findIndex((m) => m[0].trim() === title.trim());
      const headings = matches.map((m) => ({ line: content.slice(0, m.index).split("\n").length, text: m[0].trim() }));
      if (op === "list") {
        return { ok: true, value: headings, stdout: headings.length ? headings.map((h) => `${h.line}: ${h.text}`).join("\n") : "（无标题结构——纯文本文档）" };
      }
      if (op === "split") {
        // split: 从指定标题（title 参数）开始拆出后段 → 新文件（target 参数）
        const title = input.title ?? "";
        const target = input.target ?? "";
        const headingIdx = findHeading(title);
        if (headingIdx < 0) return { ok: false, error: `write.section split: 标题 "${title}" 未找到（用 write.section op=list 查看标题行——需完整如 "## 章节名"）` };
        const segStart = matches[headingIdx]!.index!;
        const head = content.slice(0, segStart).trimEnd() + "\n";
        const tail = content.slice(segStart).trimStart();
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        const targetAbs = resolveArtifact(taskWorkspace, target);
        await mkdir(dirname(targetAbs), { recursive: true });
        await writeFile(abs, head, "utf-8");
        await writeFile(targetAbs, tail, "utf-8");
        return { ok: true, value: { path: input.path, splitAt: title, target }, stdout: `已从 "${title}" 拆分 → ${target}（原文件保留 ${head.length} 字符）` };
      }
      if (op === "reorder") {
        // reorder: 将 title 章节移动到 before（目标标题前）；无 before 则移到末尾
        const title = input.title ?? "";
        const before = input.before as string | undefined;
        const headingIdx = findHeading(title);
        if (headingIdx < 0) return { ok: false, error: `write.section reorder: 标题 "${title}" 未找到（需完整标题行如 "## 章节名"）` };
        const segStart = matches[headingIdx]!.index!;
        const segEnd = headingIdx + 1 < matches.length ? matches[headingIdx + 1]!.index! : content.length;
        const segment = content.slice(segStart, segEnd);
        let rest = content.slice(0, segStart) + content.slice(segEnd);
        // 移除段后——在 before 前插入（before 也走行级匹配——防子串误插）
        if (before) {
          const bIdx = findHeading(before);
          if (bIdx < 0) return { ok: false, error: `write.section reorder: before 标题 "${before}" 未找到（需完整标题行）` };
          const bStart = rest.indexOf(matches[bIdx]![0]);
          if (bStart < 0) return { ok: false, error: `write.section reorder: before 标题 "${before}" 定位失败` };
          rest = rest.slice(0, bStart) + segment.trimEnd() + "\n\n" + rest.slice(bStart);
        } else {
          rest = rest.trimEnd() + "\n\n" + segment.trimStart();
        }
        const { writeFile } = await import("node:fs/promises");
        await writeFile(abs, rest, "utf-8");
        return { ok: true, value: { path: input.path, moved: title, before: before ?? "末尾" }, stdout: `已移动章节 "${title}" → ${before ? `"${before}" 前` : "文档末尾"}` };
      }
      return { ok: false, error: `write.section: 未知 op "${op}"（list|split|reorder）` };
    },
  };
}
