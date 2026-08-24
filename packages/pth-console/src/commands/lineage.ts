/**
 * pth lineage —— 角色谱系监督层（树状分化——有监督自动化）
 *
 *   pth lineage tree                  谱系森林（三源根 → 中间层 → 叶子——文本渲染）
 *   pth lineage proposals [--all]     分化建议列表（默认 draft 待审——refine 任务 3 产出）
 *   pth lineage show <id>             建议详情（子任务/建议角色/理由/置信度）
 *   pth lineage approve <id> [--json overrides]   批准 → 注册新角色（树生长——batch 热上线）
 *   pth lineage reject <id> [--reason x]          拒绝（archived）
 */

import { PthClient } from "../bridge/client.js";

interface ProposalEntry {
  id: string;
  kind: string;
  anchors: string[];
  status: string;
  contentPreview: string;
  meta: Record<string, unknown> | null;
}

export async function cmdHubLineage(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const client = PthClient.fromConfig();
  if (!client) {
    console.error("❌ PTH 未配置（pi-triple.json pth.url/pth.token 或 PTH_URL/PTH_TOKEN）");
    return;
  }
  const [sub, ...rest] = passthrough;

  switch (sub) {
    case "tree": {
      const d = await client.requestJson("/api/v1/kernel/lineage", { method: "GET" }) as { text: string };
      console.log(d.text);
      return;
    }

    case "proposals": {
      const status = "all" in flags ? undefined : "draft";
      const q = status ? `&status=${status}` : "";
      const d = await client.requestJson(`/api/v1/kernel/memory?kind=differentiation-proposal${q}&limit=50`, { method: "GET" }) as { entries: ProposalEntry[]; total: number };
      if (d.entries.length === 0) {
        console.log(`（无${status === "draft" ? "待审" : ""}分化建议——refine 任务 3 在任务完成后产出）`);
        return;
      }
      console.log(`═══ 分化建议（${d.entries.length}/${d.total}）═══`);
      for (const e of d.entries) {
        let parent = "?";
        let suggested = "?";
        try {
          const c = JSON.parse(e.contentPreview + "}" .repeat(0)) as Record<string, unknown>;  // preview 截断——仅取锚点
          parent = String(c.parent ?? e.anchors[0] ?? "?");
          suggested = String((c.suggestedRole as { id?: string } | null)?.id ?? "?");
        } catch { parent = e.anchors[0] ?? "?"; }
        console.log(`  ${e.id}  [${e.status}]  parent=${parent}  建议=${suggested}`);
      }
      console.log(`\n详情：pth lineage show <id>　批准：pth lineage approve <id>`);
      return;
    }

    case "show": {
      const id = rest[0];
      if (!id) { console.error("用法: pth lineage show <id>"); return; }
      const e = await client.requestJson(`/api/v1/kernel/memory/${encodeURIComponent(id)}`, { method: "GET" }) as { id: string; status: string; content: string };
      console.log(`═══ 分化建议 ${e.id} [${e.status}] ═══`);
      try {
        const c = JSON.parse(e.content) as { taskId?: string; parent?: string; subtasks?: Array<{ type: string; description: string }>; suggestedRole?: { id: string; parent: string; specialization: string; rationale: string } | null; confidence?: string | null; rationale?: string | null; status?: string };
        console.log(`来源任务: ${c.taskId ?? "?"}`);
        console.log(`父角色: ${c.parent ?? "?"}　置信度: ${c.confidence ?? "?"}`);
        console.log(`子任务（可分化模式）:`);
        for (const s of c.subtasks ?? []) console.log(`  - ${s.type}: ${s.description}`);
        if (c.suggestedRole) {
          console.log(`建议新角色:`);
          console.log(`  id: ${c.suggestedRole.id}（parent=${c.suggestedRole.parent}）`);
          console.log(`  特化: ${c.suggestedRole.specialization}`);
          console.log(`  理由: ${c.suggestedRole.rationale}`);
        }
        if (c.rationale) console.log(`总体判断: ${c.rationale}`);
        if (c.status) console.log(`处理状态: ${c.status}`);
      } catch {
        console.log(e.content.slice(0, 800));
      }
      return;
    }

    case "approve": {
      const id = rest[0];
      if (!id) { console.error("用法: pth lineage approve <id> [--json '{\"tags\":[...]}']"); return; }
      let overrides: Record<string, unknown> | undefined;
      if (flags.json) {
        try { overrides = JSON.parse(flags.json) as Record<string, unknown>; }
        catch { console.error("❌ --json 解析失败"); return; }
      }
      const d = await client.requestJson("/api/v1/kernel/lineage/approve", {
        method: "POST",
        body: JSON.stringify({ proposalId: id, overrides }),
      }) as { ok: boolean; role?: { id: string; parent: string; generation: number }; batchesSent?: number; tree?: string; error?: string };
      if (d.error) { console.error(`❌ ${d.error}`); return; }
      console.log(`✅ 分化已批准——新角色上线: ${d.role?.id}（parent=${d.role?.parent} generation=${d.role?.generation}——已推送 ${d.batchesSent} 个 batch）`);
      console.log(d.tree ?? "");
      return;
    }

    case "reject": {
      const id = rest[0];
      if (!id) { console.error("用法: pth lineage reject <id> [--reason 理由]"); return; }
      const d = await client.requestJson("/api/v1/kernel/lineage/reject", {
        method: "POST",
        body: JSON.stringify({ proposalId: id, reason: flags.reason }),
      }) as { ok?: boolean; error?: string };
      if (d.error) { console.error(`❌ ${d.error}`); return; }
      console.log(`✅ 已拒绝（archived）: ${id}`);
      return;
    }

    default:
      console.log([
        "  pth lineage tree                          谱系森林（三源根 → 中间层 → 叶子）",
        "  pth lineage proposals [--all]             分化建议列表（默认待审 draft）",
        "  pth lineage show <id>                     建议详情",
        "  pth lineage approve <id> [--json ovr]     批准分化——新角色上线",
        "  pth lineage reject <id> [--reason x]      拒绝分化建议",
      ].join("\n"));
  }
}
