/// <reference path="../sdk.d.ts" />
// @ts-check
// web-fetch 扩展——只读 web 检索（走 ctx.http 标准通道——协议/超时/大小上限由通道保证）
module.exports = /** @type {PthExtFactory} */ async function factory(ctx) {
  return {
    tools: {
      "web.get": async (args) => {
        const url = String(args?.url ?? "").trim();
        if (!url) return { ok: false, error: "web.get: url 必填" };
        if (!ctx.http) return { ok: false, error: "web.get: 运行环境无 http 通道" };
        const r = await ctx.http.get(url, { maxBytes: Number(args?.maxBytes) || undefined });
        return r.ok
          ? { ok: true, result: r.text, meta: { status: r.status, bytes: r.bytes, contentType: r.contentType, url } }
          : { ok: false, error: r.error };
      },
    },
    capabilities: {},
  };
};
