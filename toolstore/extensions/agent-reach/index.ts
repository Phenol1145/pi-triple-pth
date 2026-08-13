/// <reference path="../sdk.d.ts" />
// @ts-check
// agent-reach 扩展——互联网调研路由（供 spider-web/spider-github 角色）
// 封装 agent-reach skill 的零配置通道：Exa 网页搜索 / jina-reader 网页阅读 / gh 仓库搜索 /
// bili B站搜索 / V2EX 热门 / agent-reach doctor & check-update。
// 风格对齐 web-fetch：ctx 标准通道（exec/http）+ 超时保护 + 输出截断 + 结构化结果。
// 登录态平台（twitter/reddit/xhs/facebook/instagram/linkedin）不在 v1 封装范围——doctor 返回提示走现有通道。
module.exports = /** @type {PthExtFactory} */ async function factory(ctx) {
  const LOGIN_PLATFORMS = ["twitter", "reddit", "xhs", "facebook", "instagram", "linkedin"];
  const MAX_RESULT_CHARS = 64 * 1024; // 单工具结果截断上限（64KB）

  /** 截断长输出（对齐 web-fetch 大小上限思路） */
  const cut = (s, n) => {
    const str = String(s ?? "");
    if (str.length <= n) return str;
    return str.slice(0, n) + "\n...[截断 " + (str.length - n) + " 字符]";
  };

  /** bash 执行统一入口：超时 + 输出上限由 exec 通道保证，异常兜底转结构化错误 */
  async function runExec(cmd, args, timeoutMs, maxBytes) {
    if (!ctx || !ctx.exec) return { ok: false, error: "运行环境无 exec 通道（ctx.exec 缺失）" };
    try {
      const r = await ctx.exec(cmd, args, {
        timeoutMs: timeoutMs ?? 20000,
        maxOutputBytes: maxBytes ?? 256 * 1024,
      });
      return r ?? { ok: false, error: "exec 返回空结果" };
    } catch (e) {
      return { ok: false, error: "exec 异常: " + String((e && e.message) || e) };
    }
  }

  /** http 只读获取统一入口（协议/大小上限由通道保证） */
  async function runHttp(url, timeoutMs, maxBytes) {
    if (!ctx || !ctx.http || !ctx.http.get) return { ok: false, error: "运行环境无 http 通道（ctx.http.get 缺失）" };
    try {
      return await ctx.http.get(url, { timeoutMs: timeoutMs ?? 20000, maxBytes: maxBytes ?? 512 * 1024 });
    } catch (e) {
      return { ok: false, error: "http 异常: " + String((e && e.message) || e) };
    }
  }

  /** 安全 JSON 解析（CLI stdout 可能是 json 也可能是纯文本） */
  function parseJsonSafe(text) {
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }


  /** 整数钳制：非法/<=0 → 默认值；否则 round 后钳到 [min,max] */
  function clampInt(v, def, min, max) {
    const raw = Number(v);
    if (!Number.isFinite(raw) || raw <= 0) return def;
    return Math.min(max, Math.max(min, Math.round(raw)));
  }

  const ok = (result, meta = {}) => ({ ok: true, result, meta: meta ?? {} });
  const fail = (error, meta = {}) => ({ ok: false, error, meta: meta ?? {} });

  return {
    tools: {
      /** Exa 网页搜索（mcporter 路由——agent-reach 后端）；jina 搜索为兜底 */
      "reach.webSearch": async (args) => {
        const query = String((args && args.query) ?? "").trim();
        if (!query) return fail("reach.webSearch: query 必填");
        const n = clampInt(args && args.n, 5, 1, 20);
        const meta0 = { backend: "mcporter:exa", query, n };
        const forms = [
          ["mcporter", ["call", "exa.web_search_exa", "--query", query, "--numResults", String(n), "--json"]],
          ["mcporter", ["call", "exa", "web_search_exa", "--query", query, "--numResults", String(n), "--json"]],
        ];
        for (const [cmd, a] of forms) {
          const r = await runExec(cmd, a, 30000, 512 * 1024);
          if (r.ok && r.stdout && r.stdout.trim()) {
            const parsed = parseJsonSafe(r.stdout);
            if (parsed.ok) {
              const data = parsed.data;
              const rows = Array.isArray(data) ? data : ((data && (data.results || data.data)) ?? []);
              return ok(cut(JSON.stringify(rows ?? data), MAX_RESULT_CHARS), {
                ...meta0, mode: "json", rows: Array.isArray(rows) ? rows.length : undefined,
              });
            }
            return ok(cut(r.stdout, MAX_RESULT_CHARS), { ...meta0, mode: "text" });
          }
        }
        const jr = await runHttp("https://s.jina.ai/" + encodeURIComponent(query), 20000, 512 * 1024);
        if (jr.ok && jr.text) return ok(cut(jr.text, MAX_RESULT_CHARS), { backend: "jina-search", query, n });
        return fail("reach.webSearch: Exa（mcporter）与 jina 兜底均失败——请先运行 reach.doctor 检查后端激活（或配置 EXA_API_KEY / mcporter 注册）", meta0);
      },

      /** 通用网页阅读（jina reader——https://r.jina.ai/<url>——免 key 零配置，返回 markdown） */
      "reach.webRead": async (args) => {
        const url = String((args && args.url) ?? "").trim();
        if (!url) return fail("reach.webRead: url 必填");
        if (!/^https?:\/\//i.test(url)) return fail("reach.webRead: 仅支持 http(s) URL");
        const r = await runHttp("https://r.jina.ai/" + url, 30000, 512 * 1024);
        if (r.ok && r.text) {
          return ok(cut(r.text, MAX_RESULT_CHARS), {
            backend: "jina-reader", status: r.status, bytes: r.bytes, contentType: r.contentType, url,
          });
        }
        return fail("reach.webRead: jina reader 读取失败: " + (r.error || ("status=" + r.status)), { backend: "jina-reader", url });
      },

      /** GitHub 仓库搜索（gh search repos——结构化 JSON 输出） */
      "reach.ghSearch": async (args) => {
        const query = String((args && args.query) ?? "").trim();
        if (!query) return fail("reach.ghSearch: query 必填");
        const sorts = ["stars", "forks", "updated", "best-match"];
        let sort = String((args && args.sort) ?? "stars");
        if (!sorts.includes(sort)) sort = "stars";
        const limit = clampInt(args && args.limit, 10, 1, 50);
        const r = await runExec("gh", ["search", "repos", query, "--sort", sort, "--limit", String(limit), "--json", "fullName,description,stargazersCount,url,language,updatedAt"], 30000, 512 * 1024);
        if (!r.ok) {
          return fail("reach.ghSearch: gh CLI 执行失败: " + (r.error || r.stderr || "gh 未安装或未登录（gh auth login）"), { backend: "gh-cli" });
        }
        const parsed = parseJsonSafe(r.stdout ?? "");
        if (!parsed.ok) return ok(cut(r.stdout ?? "", MAX_RESULT_CHARS), { backend: "gh-cli", mode: "text", query, sort, limit });
        return ok(parsed.data, {
          backend: "gh-cli", mode: "json", query, sort, limit,
          count: Array.isArray(parsed.data) ? parsed.data.length : undefined,
        });
      },

      /** B站搜索（bili search CLI——agent-reach references/video.md 通道） */
      "reach.biliSearch": async (args) => {
        const query = String((args && args.query) ?? "").trim();
        if (!query) return fail("reach.biliSearch: query 必填");
        const n = clampInt(args && args.n, 10, 1, 50);
        const r = await runExec("bili", ["search", query, "--limit", String(n)], 30000, 512 * 1024);
        if (!r.ok) {
          return fail("reach.biliSearch: bili CLI 执行失败: " + (r.error || r.stderr || "bili 未安装（参考 agent-reach references/video.md）"), { backend: "bili-cli" });
        }
        const parsed = parseJsonSafe(r.stdout ?? "");
        if (parsed.ok) return ok(parsed.data, { backend: "bili-cli", mode: "json", query, n });
        return ok(cut(r.stdout ?? "", MAX_RESULT_CHARS), { backend: "bili-cli", mode: "text", query, n });
      },

      /** V2EX 热门话题（官方 API——免 key 零配置） */
      "reach.v2exHot": async (args) => {
        const n = clampInt(args && args.n, 20, 1, 100);
        const r = await runHttp("https://www.v2ex.com/api/topics/hot.json", 15000, 512 * 1024);
        if (!r.ok || !r.text) return fail("reach.v2exHot: V2EX API 请求失败: " + (r.error || ("status=" + r.status)), { backend: "v2ex-api" });
        const parsed = parseJsonSafe(r.text);
        if (!parsed.ok || !Array.isArray(parsed.data)) return fail("reach.v2exHot: V2EX API 返回非预期格式", { backend: "v2ex-api" });
        const rows = parsed.data.slice(0, n).map((t) => ({
          title: (t && t.title) ?? "",
          url: "https://www.v2ex.com/t/" + ((t && t.id) ?? ""),
          replies: (t && t.replies) ?? 0,
          node: ((t && t.node && (t.node.title || t.node.name))) ?? "",
        }));
        return ok(rows, { backend: "v2ex-api", count: rows.length, requested: n });
      },

      /** 后端体检（agent-reach doctor --json——返回激活后端 + 零配置通道 + 登录态平台提示） */
      "reach.doctor": async () => {
        const base = {
          backend: "agent-reach-cli",
          loginRequiredPlatforms: LOGIN_PLATFORMS,
          hint: "登录态平台（twitter/reddit/xhs/facebook/instagram/linkedin）未在 v1 封装范围——请走现有通道（浏览器会话/manual 流程）",
        };
        const r = await runExec("agent-reach", ["doctor", "--json"], 20000, 512 * 1024);
        if (!r.ok) {
          return fail("reach.doctor: agent-reach CLI 执行失败: " + (r.error || r.stderr || "agent-reach 未安装（/Users/anzhize/.local/bin/agent-reach）"), base);
        }
        const parsed = parseJsonSafe(r.stdout ?? "");
        if (parsed.ok) return ok(parsed.data, base);
        return ok(cut(r.stdout ?? "", MAX_RESULT_CHARS), { ...base, mode: "text" });
      },

      /** 版本检查（agent-reach check-update） */
      "reach.checkUpdate": async () => {
        const r = await runExec("agent-reach", ["check-update"], 15000, 128 * 1024);
        if (!r.ok) {
          return fail("reach.checkUpdate: agent-reach CLI 执行失败: " + (r.error || r.stderr || "agent-reach 未安装"), { backend: "agent-reach-cli" });
        }
        return ok(cut(r.stdout ?? "", MAX_RESULT_CHARS), { backend: "agent-reach-cli" });
      },
    },
    capabilities: {},
  };
};
