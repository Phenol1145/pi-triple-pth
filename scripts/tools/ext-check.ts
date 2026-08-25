/**
 * ext-check.ts —— 扩展开发验证工具（2026-08-12 SDK 完善）。
 *
 * 检查项：
 *   1. plugin.json 结构（parseExtManifest 校验）+ contracts 声明与 index.ts 实现对齐
 *   2. index.ts 类型检查（tsc --noEmit --checkJs——sdk.d.ts 引用生效——TS 语法误用报错）
 *   3. 装载冒烟（ExtRegistry.loadAll——真实装载 + 每个 tools 可调用：空参数调用不炸）
 *
 * 用法：npm run ext:check  或  npx tsx scripts/tools/ext-check.ts [扩展id...]
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createToolstore } from "@away_from/pth-kernel-interpreter";
import { ExtRegistry, buildStdExtChannels, type ExtContext } from "@away_from/pth-kernel-interpreter";
import { classifyExtensionDir } from "../../src/pth/catalog/extensions/extension-policy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLSTORE = path.join(ROOT, "toolstore");

async function main(): Promise<number> {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const ts = createToolstore(TOOLSTORE);
  const allDirs = await ts.listDirs("extensions");
  const targets = ids.length > 0 ? ids : allDirs;
  let failures = 0;

  for (const id of targets) {
    const dir = path.join(TOOLSTORE, "extensions", id);
    const pluginJson = path.join(dir, "plugin.json");
    // P3-3：目录分类——无 plugin.json 的外来工具目录不报错；坏插件失败并给诊断
    const hasPluginJson = await import("node:fs/promises").then(({ access }) => access(pluginJson).then(() => true).catch(() => false));
    let manifest: { contracts?: unknown } | undefined;
    let manifestError: string | undefined;
    if (hasPluginJson) {
      try {
        manifest = JSON.parse(await ts.readText(`extensions/${id}/plugin.json`)) as { contracts?: unknown };
      } catch (e) {
        manifestError = (e as Error).message;
      }
    }
    const classification = classifyExtensionDir({ hasPluginJson, manifest, manifestError });
    if (classification.class === "external-dir") {
      console.log(`── ${id}：外来工具目录（无 plugin.json）——跳过（不报错）`);
      continue;
    }
    if (classification.class === "bad-plugin") {
      console.error(`── ${id}：坏插件（${classification.diagnostics.join("；")}）`);
      failures++;
      continue;
    }
    // 入口探测：index.js 优先（checkJs + JSDoc 类型友好）——index.ts 向后兼容
    let indexFile = path.join(dir, "index.js");
    try {
      const { access } = await import("node:fs/promises");
      await access(indexFile);
    } catch {
      indexFile = path.join(dir, "index.ts");
    }
    console.log(`── 扩展 ${id}（indexFile=${path.relative(ROOT, indexFile)}）`);

    // 1. manifest 校验（结构 + contracts 声明可解析）
    let declared: string[] = [];
    try {
      const manifestText = await ts.readText(`extensions/${id}/plugin.json`);
      const { parseExtManifest } = await import("@away_from/pth-kernel-interpreter");
      const manifest = parseExtManifest(manifestText);
      declared = manifest.contracts.tools ?? [];
      console.log(`  ✓ manifest 校验通过（tools: ${declared.join(",") || "-"}）`);
    } catch (e) {
      console.error(`  ✗ plugin.json 校验失败: ${(e as Error).message}`);
      failures++;
    }

    // 2. 类型检查（tsc checkJs——sdk.d.ts 引用）——捕获 stdout+stderr 全量
    try {
      execFileSync("npx", ["tsc", "--noEmit", "--allowJs", "--checkJs", "--module", "commonjs", "--target", "es2022",
        "--moduleResolution", "node", "--lib", "es2022,dom", "--strict", "false",
        path.relative(ROOT, indexFile)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
      console.log("  ✓ 类型检查通过（checkJs + sdk.d.ts）");
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      const out = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
      const lines = out.split("\n").filter((l) => l.includes("error TS")).slice(0, 4);
      console.error(`  ✗ 类型检查失败:\n${lines.map((l) => `    ${l.trim()}`).join("\n") || `    ${out.split("\n")[0]?.trim() || "(无错误输出)"}`}`);
      failures++;
    }

    // 3. 装载冒烟（真实装载 + tools 空参数调用）
    try {
      const stdChannels = buildStdExtChannels({
        dbQuery: async (table) => ({ ok: true, table }),
        execAllowlist: undefined,
      });
      const ctx: ExtContext = {
        memory: { query: async () => [], write: async () => ({ ok: true }) },
        log: (m) => console.log(`    [ext:${id}] ${m}`),
        ...stdChannels,
      };
      const reg = new ExtRegistry({ toolstore: ts, extContext: ctx });
      const loaded = await reg.loadOne(id);
      const toolNames = Object.keys(loaded.tools);
      console.log(`  ✓ 装载成功（tools: ${toolNames.join(",") || "-"}）`);
      // 1b. manifest contracts 与实现对齐（装载后比对——实现为准）
      const missing = declared.filter((t) => !toolNames.includes(t));
      const extra = toolNames.filter((t) => !declared.includes(t));
      if (missing.length > 0 || extra.length > 0) {
        console.error(`  ✗ manifest 与实现不对齐（声明未实现: ${missing.join(",") || "-"}；实现未声明: ${extra.join(",") || "-"}）`);
        failures++;
      } else {
        console.log("  ✓ manifest contracts 与实现对齐");
      }
      for (const [name, fn] of Object.entries(loaded.tools)) {
        try {
          const r = (await fn({})) as { ok?: boolean; error?: string };
          if (r?.ok === false && !String(r.error ?? "").includes("必填")) {
            console.log(`    ~ ${name}({}) → error: ${String(r.error).slice(0, 60)}`);
          } else {
            console.log(`    ✓ ${name}({}) → ok=${String(r.ok)}`);
          }
        } catch (e) {
          console.error(`    ✗ ${name}({}) 调用抛错: ${(e as Error).message.slice(0, 80)}`);
          failures++;
        }
      }
    } catch (e) {
      console.error(`  ✗ 装载失败: ${(e as Error).message}`);
      failures++;
    }
  }

  console.log(failures === 0 ? `\n✅ 扩展检查全部通过（${targets.length} 个）` : `\n❌ ${failures} 项失败`);
  return failures === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
