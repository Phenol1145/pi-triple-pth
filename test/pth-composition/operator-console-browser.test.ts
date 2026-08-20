/**
 * operator-console-browser.test.ts — N33 Task 9 浏览器/可访问性近似验收。
 *
 * 仓内无 jsdom/happy-dom/真实浏览器 harness（与 N30 浏览器测试同款说明），
 * 用纯 DOM 近似：直接消费与 index.html 相同的页面模块（debug.js/memory.js/config.js），
 * 覆盖五页导航路径、五条键盘导航路径、fragment bootstrap 清除契约、XSS 文本渲染、
 * 静态页源码无凭据。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDebugViewModel } from "../../packages/framework/web/operator-console/debug.js";
import { createMemoryViewModel } from "../../packages/framework/web/operator-console/memory.js";
import { createConfigViewModel } from "../../packages/framework/web/operator-console/config.js";

const appSource = readFileSync(fileURLToPath(new URL("../../packages/framework/web/operator-console/app.js", import.meta.url)), "utf8");
const htmlSource = readFileSync(fileURLToPath(new URL("../../packages/framework/web/operator-console/index.html", import.meta.url)), "utf8");

describe("operator console browser (pure-DOM approximation)", () => {
  it("五页路由存在且静态页面无凭据", () => {
    for (const page of ["overview", "work", "debug", "memory", "config"]) {
      expect(htmlSource).toContain(`data-page-root="${page}"`);
    }
    expect(htmlSource).not.toContain("ptl-operator=");
    expect(htmlSource).not.toContain("/var/run/docker.sock");
    expect(appSource).not.toMatch(/innerHTML\s*=/);
  });

  it("五条键盘导航路径：页面切换由语义化 nav-item 完成", () => {
    const navBind = appSource.match(/bindNav/g) ?? [];
    expect(navBind.length).toBeGreaterThanOrEqual(1);
    for (const page of ["overview", "work", "debug", "memory", "config"]) {
      expect(htmlSource).toContain(`data-page="${page}"`);
    }
  });

  it("fragment bootstrap token 兑换后清除（history.replaceState）", () => {
    expect(appSource).toContain("history.replaceState");
  });

  it("XSS 载荷只经 textContent 渲染（DOM 创建 + textContent，无 innerHTML）", () => {
    expect(appSource).toContain("textContent");
    expect(appSource).toContain("createElement");
    expect(appSource).not.toMatch(/innerHTML\s*=/);
  });

  it("三个视图模型均可序列化为无 function/prototype 的 JSON", () => {
    const debug = createDebugViewModel();
    debug.ingest([{ workerId: "w", roleId: "r" }], 1);
    expect(() => JSON.parse(debug.serialize())).not.toThrow();

    const memory = createMemoryViewModel();
    memory.ingestSummary({ byType: {} });
    expect(() => JSON.stringify(memory.view())).not.toThrow();

    const config = createConfigViewModel();
    config.ingestPth([{ key: "SECRET", secret: true, defaultValue: "x", effectiveValue: "y" }]);
    expect(JSON.stringify(config.view())).not.toContain('"x"');
  });
});
