/**
 * commands/run.ts — pth run 命令
 *
 * 远端运行程序，SSE 流式打印到终端。
 * k=v 参数 → input object；孤立词 → input.text。
 */
import { PthClient } from "../bridge/client.js";

/**
 * 解析 k=v 参数：k=v 对进 object，孤立词进 text。
 */
function parseInput(args: string[]): string | Record<string, string> {
  const obj: Record<string, string> = {};
  let textParts: string[] = [];

  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq > 0) {
      obj[arg.slice(0, eq)] = arg.slice(eq + 1);
    } else {
      textParts.push(arg);
    }
  }

  if (textParts.length > 0) {
    obj["text"] = textParts.join(" ");
  }

  return Object.keys(obj).length > 0 ? obj : "";
}

export async function cmdRun(name: string, args: string[], flags: Record<string, string>): Promise<void> {
  if (!name) {
    console.log("  用法: pth run <program> [k=v...] [--version N]");
    process.exit(1);
  }

  const client = PthClient.fromConfig();
  if (!client) {
    console.log("  \x1b[31m❌ 未配置 PTH 连接\x1b[0m");
    console.log("  配置: export PTH_URL=<url> PTH_TOKEN=<token>");
    process.exit(1);
  }

  const input = parseInput(args);
  const version = flags.version ? parseInt(flags.version, 10) : undefined;
  if (flags.version !== undefined && (isNaN(version!) || version! < 1)) {
    console.log(`  \x1b[31m❌ 版本号无效: ${flags.version}\x1b[0m`);
    process.exit(1);
  }

  console.log(`\x1b[2m运行 ${name}${version ? " v" + version : ""}…\x1b[0m\n`);

  try {
    for await (const event of client.run(name, input, version)) {
      switch (event.type) {
        case "message_update": {
          const data = event.data as Record<string, unknown>;
          // 真实结构：data.assistantMessageEvent = {type: "text_delta"|"thinking_delta", delta}
          const ame = (data.assistantMessageEvent ?? data) as Record<string, unknown>;
          const delta = ame.delta as string | undefined;
          const subType = ame.type as string | undefined;
          if (delta && subType === "text_delta") {
            process.stdout.write(delta);
          } else if (delta && subType === "thinking_delta") {
            process.stdout.write(`\x1b[2m${delta}\x1b[0m`);
          }
          break;
        }
        case "tool_execution_start": {
          const data = event.data as Record<string, unknown>;
          const toolName = (data.toolName ?? data.name ?? "?") as string;
          const toolInput = data.args ?? data.input;
          const inputFull = typeof toolInput === "string" ? toolInput : (JSON.stringify(toolInput) ?? "");
          console.log(`\n\x1b[2m🔧 ${toolName} ${inputFull.slice(0, 60)}${inputFull.length > 60 ? "…" : ""}\x1b[0m`);
          break;
        }
        case "tool_execution_end": {
          const data = event.data as Record<string, unknown>;
          const output = data.output;
          if (output !== undefined) {
            const outFull = typeof output === "string" ? output : (JSON.stringify(output) ?? "");
            console.log(`\x1b[2m   → ${outFull.slice(0, 200)}${outFull.length > 200 ? "…" : ""}\x1b[0m`);
          }
          break;
        }
        case "error": {
          const data = event.data as Record<string, unknown>;
          console.log(`\n\x1b[31m❌ ${data.message ?? "运行错误"}\x1b[0m`);
          break;
        }
        case "agent_end": {
          // 运行结束
          break;
        }
        default:
          // silently ignore unknown event types
          break;
      }
    }
    console.log(""); // final newline
  } catch (err: any) {
    console.log(`\n\x1b[31m❌ 运行失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  console.log(`\x1b[2m运行完成\x1b[0m`);
}
