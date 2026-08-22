/**
 * launchd.test.ts —— B4 LaunchAgent 托管（纯函数单测；不触碰 launchctl）。
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { HostServiceManifest } from "../../src/pth/services/service-manifest.js";
import {
  launchdLabel,
  renderLaunchdPlist,
  resolvePthBinary,
  xmlEscape,
} from "../../src/pth/services/launchd.js";

function hostManifest(): HostServiceManifest {
  return {
    schemaVersion: 1,
    kind: "host",
    id: "local-lean",
    description: "lean local executor",
    command: ["pth", "local-exec", "--port", "8787"],
    tokenEnv: "LOCAL_EXEC_SHARED_SECRET",
    healthUrl: "http://127.0.0.1:8787/health",
    readyTimeoutMs: 30000,
    stopGraceMs: 5000,
    pathMapping: { hostRoot: "/data/workspaces", execRootEnv: "PTH_WORKSPACES_HOST" },
  };
}

describe("launchd plist 渲染", () => {
  it("渲染完整 LaunchAgent：label/命令/env/自恢复/日志", () => {
    const plist = renderLaunchdPlist(hostManifest(), {
      env: {
        LOCAL_EXEC_SHARED_SECRET: "secret-abc",
        PTH_WORKSPACES_HOST: "/tmp/ws",
        LOCAL_EXEC_PATH_MAPPINGS: '[{"hostRoot":"/data/workspaces","execRoot":"/tmp/ws"}]',
        PATH: "/usr/local/bin:/usr/bin:/bin",
      },
      logFile: "/Users/me/.pi-triple/logs/services/local-lean.log",
      pthBin: "/usr/local/bin/pth",
    });
    expect(plist).toContain(`<string>${launchdLabel("local-lean")}</string>`);
    expect(plist).toContain("<string>/usr/local/bin/pth</string>");
    expect(plist).toContain("<string>local-exec</string>");
    expect(plist).toContain("<string>8787</string>");
    expect(plist).toContain("<key>LOCAL_EXEC_SHARED_SECRET</key>");
    expect(plist).toContain("<string>secret-abc</string>");
    expect(plist).toContain("<key>PTH_WORKSPACES_HOST</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("local-lean.log");
  });

  it("XML 转义防注入（env 含 <>&\"'）", () => {
    const plist = renderLaunchdPlist(hostManifest(), {
      env: { TOKEN: `<a>&"b"'` },
      logFile: "/tmp/x.log",
      pthBin: "/usr/local/bin/pth",
    });
    expect(plist).toContain("<string>&lt;a&gt;&amp;&quot;b&quot;&apos;</string>");
  });

  it("command 中的 pth 替换为绝对 pthBin；env 空值被过滤", () => {
    const plist = renderLaunchdPlist(hostManifest(), {
      env: { LOCAL_EXEC_SHARED_SECRET: "s", EMPTY: "" },
      logFile: "/tmp/x.log",
      pthBin: "/opt/pth/pth",
    });
    expect(plist).toContain("<string>/opt/pth/pth</string>");
    expect(plist).not.toContain("<key>EMPTY</key>");
  });
});

describe("resolvePthBinary", () => {
  it("PTH_PTH_BIN 显式优先", () => {
    expect(resolvePthBinary({ PTH_PTH_BIN: "/opt/pth/pth", PATH: "/usr/bin" })).toBe("/opt/pth/pth");
  });

  it("PATH 中可执行 pth 被找到；找不到回退 /usr/local/bin/pth", () => {
    const dir = mkdtempSync(join(tmpdir(), "pth-launchd-"));
    try {
      writeFileSync(join(dir, "pth"), "#!/usr/bin/env node\n");
      const env = { PATH: `${dir}${delimiter}/usr/bin` };
      expect(resolvePthBinary(env)).toBe(join(dir, "pth"));
      expect(resolvePthBinary({ PATH: "/usr/bin" })).toBe("/usr/local/bin/pth");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
