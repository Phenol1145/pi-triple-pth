/**
 * nl-translator —— 自然语言任务支持（NL → 代码转译层）。
 *
 * 分类凭据（用户裁决）：**标签作为主要凭据，不用正则强行筛**——
 *   任务发布时 tags 含 "nl"（或 payload.kind === "nl"）→ 按自然语言转译；
 *   否则一律按可执行代码处理（零误判、零启发式）。
 *
 * 转译：llm.complete（系统 prompt 含能力白名单 + Observation 协议 + 输出格式）→ 剥离代码块围栏。
 * 失败：转译失败 → 调用方 terminal reject（nl-translate-failed）——坏任务不回池。
 */
import type { LlmFn } from "../interpreter/llm-fn.js";

/** 自然语言任务的判定（标签为主要凭据） */
export interface NlTaskLike {
  tags?: string[];
  payload?: unknown;
}

export function isNaturalLanguageTask(task: NlTaskLike): boolean {
  if ((task.payload as { kind?: string } | undefined)?.kind === "nl") return true;
  return (task.tags ?? []).some((t) => t.toLowerCase() === "nl");
}

export interface TranslateInput {
  title: string;
  text: string;
}

export type TranslateResult =
  | { ok: true; code: string }
  | { ok: false; error: string };

const SYSTEM_PROMPT = `你是任务转译器：把用户的自然语言任务转译为可执行的 TypeScript 代码。
约束：
1. 输出纯代码（不要解释、不要 markdown 围栏之外的文字）；代码必须 return 一个对象作为结果。
2. 可用的能力（全部 await 调用）：
   - python.execute("python 代码")——Python 执行（python 里设 _result = 值 返回）
     ⚠️ 返回对象 { ok, value, stdout, stderr, error }——取 .value 得到 _result（number/string 等），不要直接对返回值调用字符串方法！
     示例：const r = await python.execute("_result = 6 * 7"); return { v: r.value };
   - bash.execute("shell 命令")——bash 执行（返回 { stdout, stderr, code }——stdout 才是输出文本）
   - llm.complete([{role, content}])——LLM 调用（返回 { content }）
   - web.fetchText(url)——只读网络获取（返回文本）
   - fs.readText(path) / fs.list(dir)——工具文件读取
   - state.recallFunctions() / recallInsights()——记忆召回
3. 纯计算可直接写 TS；任务未明确语言时优先用 TS 内联实现，涉及系统/网络再调能力。
4. 转译代码在沙箱 vm 执行——不允许 require/import 外部模块、不允许写文件系统（fs 只读）。
5. 如果任务无法转译（过于模糊/需要人工），输出：return { error: "无法自动执行：<原因>" };`;

/** 剥离 markdown 代码块围栏（```ts / ``` 包裹） */
function stripCodeFence(content: string): string {
  const m = content.match(/```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/);
  const code = m ? m[1]! : content;
  return code.trim();
}

export async function translateTask(
  deps: { llm: LlmFn },
  input: TranslateInput,
): Promise<TranslateResult> {
  try {
    const res = await deps.llm.complete(
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `任务标题：${input.title}\n任务描述：${input.text}`,
        },
      ],
      { model: process.env.PTH_NL_MODEL ?? "deepseek-v4-flash", provider: "deepseek" },
    );
    const code = stripCodeFence(res.content);
    if (!code || code.length < 3) {
      return { ok: false, error: "nl-translate-failed: LLM 返回空代码" };
    }
    return { ok: true, code };
  } catch (e) {
    return { ok: false, error: `nl-translate-failed: ${(e as Error).message}` };
  }
}
