/**
 * commands/flags.ts —— pth 命令参数解析（与 ptl parseArgs 兼容的桥接面）。
 *
 * 迁移自 packages/framework/src/cli/args.ts 的语义：--flag value 形式进 flags，
 * 其余位置参数进 passthrough；子命令由调用方自行取 passthrough[0]。
 */

const VALUED_FLAGS = new Set([
  "template", "project", "model", "provider", "thinking", "name", "workspace",
  "workloop", "at", "agent", "slot", "urgency", "from", "mode", "url", "anchors",
  "entryId", "kind", "section", "task", "description", "tags", "limit", "event",
  "match", "task-title", "task-text", "max-fires", "reason", "proposal", "port", "host",
  "timeout", "tail", "version", "copies", "weights", "role", "batch", "json",
]);

export interface ParsedCommandArgs {
  readonly flags: Record<string, string>;
  readonly passthrough: string[];
}

export function parseCommandArgs(args: string[]): ParsedCommandArgs {
  const flags: Record<string, string> = {};
  const passthrough: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (VALUED_FLAGS.has(key)) {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`flag --${key} requires a value`);
        }
        flags[key] = value;
        i += 1;
      } else {
        flags[key] = "true";
      }
    } else {
      passthrough.push(arg);
    }
  }
  return { flags, passthrough };
}
