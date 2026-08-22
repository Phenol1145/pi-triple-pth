/**
 * operator-console-browser.test.ts — Operator Console 浏览器/可访问性近似验收（Preact 版）。
 *
 * 仓内无 jsdom/happy-dom/真实浏览器 harness，用纯源码近似：直接读取 web-src 的
 * 页面/组件源码，覆盖五页路由、键盘导航、XSS 文本渲染、静态页源码无凭据。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDebugViewModel } from "../../packages/pth-console/web-src/src/view-models/debug.js";
import { createMemoryViewModel } from "../../packages/pth-console/web-src/src/view-models/memory.js";
import { createConfigViewModel } from "../../packages/pth-console/web-src/src/view-models/config.js";

const root = new URL("../../packages/pth-console/web-src/", import.meta.url);
const htmlSource = readFileSync(fileURLToPath(new URL("index.html", root)), "utf8");
const appSource = readFileSync(fileURLToPath(new URL("src/app.tsx", root)), "utf8");
const sidebarSource = readFileSync(fileURLToPath(new URL("src/components/Sidebar.tsx", root)), "utf8");
const commandPaletteSource = readFileSync(fileURLToPath(new URL("src/components/CommandPalette.tsx", root)), "utf8");
const pageSources = new Map(
  (["overview", "work", "debug", "memory", "config"] as const).map((page) => [
    page,
    readFileSync(fileURLToPath(new URL(`src/pages/${page}.tsx`, root)), "utf8"),
  ]),
);

describe("operator console browser (Preact source approximation)", () => {
  it("五页路由存在且静态页面无凭据", () => {
    for (const page of ["overview", "work", "debug", "memory", "config"]) {
      expect(pageSources.get(page)).toContain(`data-page-root="${page}"`);
    }
    expect(htmlSource).not.toContain("ptl-operator=");
    expect(htmlSource).not.toContain("/var/run/docker.sock");
    for (const source of [appSource, sidebarSource, commandPaletteSource, ...pageSources.values()]) {
      expect(source).not.toMatch(/innerHTML\s*=/);
      expect(source).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("五条导航路径：Sidebar 语义化按钮 + CommandPalette 键盘导航", () => {
    expect(sidebarSource).toContain("NAV_PAGES");
    for (const page of ["overview", "work", "debug", "memory", "config"]) {
      expect(sidebarSource).toContain(`"${page}"`);
    }
    expect(commandPaletteSource).toContain("onKeyDown");
    expect(commandPaletteSource).toContain("ArrowDown");
    expect(commandPaletteSource).toContain("ArrowUp");
  });

  it("页面切换由 app.tsx 的 PAGE_COMPONENTS 完成", () => {
    expect(appSource).toContain("PAGE_COMPONENTS");
    for (const page of ["overview", "work", "debug", "memory", "config"]) {
      expect(appSource).toContain(`${page}:`);
    }
  });

  it("XSS 载荷只经 Preact 转义渲染（无 innerHTML / dangerouslySetInnerHTML）", () => {
    for (const source of [appSource, ...pageSources.values()]) {
      expect(source).not.toMatch(/innerHTML\s*=/);
      expect(source).not.toContain("dangerouslySetInnerHTML");
    }
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
