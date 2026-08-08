/**
 * commands.ts — /pthtask 命令解析纯函数（任务工具 Task 4）
 * 与扩展 handler 分离：可测试、可复用（ptl CLI 侧未来可共享）。
 */

export type PthtaskCommand =
  | { kind: "publish"; desc: string; tags?: string[] }
  | { kind: "ls"; limit: number }
  | { kind: "batch"; action: "add" | "remove"; count: number }
  | { kind: "status" }
  | { kind: "help" };

export function parsePthtaskArgs(args: string): PthtaskCommand {
  const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const cmd = argv[0];
  switch (cmd) {
    case "publish": {
      const tagsIdx = argv.indexOf("--tags");
      let desc = "";
      let tags: string[] | undefined;
      if (tagsIdx >= 0) {
        tags = (argv[tagsIdx + 1] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
        desc = argv.slice(1, tagsIdx).join(" ");
      } else {
        desc = argv.slice(1).join(" ");
      }
      if (!desc) return { kind: "help" };
      return { kind: "publish", desc, tags };
    }
    case "ls": {
      const limitIdx = argv.indexOf("--limit");
      const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1] ?? "20", 10) || 20 : 20;
      return { kind: "ls", limit };
    }
    case "batch": {
      const action = argv[1];
      if (action !== "add" && action !== "remove") return { kind: "help" };
      const n = Math.min(Math.max(parseInt(argv[2] ?? "1", 10) || 1, 1), 10);
      return { kind: "batch", action, count: n };
    }
    case "status":
      return { kind: "status" };
    default:
      return { kind: "help" };
  }
}

export function renderHelp(): string {
  return [
    "PTH 任务发布工具",
    "  /pthtask publish <描述> [--tags a,b]   发布任务",
    "  /pthtask ls [--limit n]                任务列表",
    "  /pthtask status                        运行状态全景",
    "  /pthtask batch add|remove [n]          batch 扩缩容",
  ].join("\n");
}

export function renderTasks(tasks: Array<Record<string, unknown>>): string {
  if (tasks.length === 0) return "暂无任务。发布: /pthtask publish <描述>";
  const lines = tasks.map((t) => {
    const id = String(t.id ?? "").slice(0, 10);
    const status = String(t.status ?? "?");
    const title = String(t.title ?? "");
    return `  ${id}  ${status.padEnd(10)}  ${title}`;
  });
  return `PTH 任务（${tasks.length}）:\n${lines.join("\n")}`;
}
