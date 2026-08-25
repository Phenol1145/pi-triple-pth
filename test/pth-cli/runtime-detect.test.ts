import { describe, expect, it } from "vitest";
import {
  classifyContainerRuntime,
  detectContainerRuntime,
  runtimeCapabilities,
  type CommandRunner,
} from "../../src/cli/runtime/targets/index.js";

function fakeRunner(cases: Array<{ cmd: string; argv: string[]; run: () => { code: number; stdout: string; stderr: string } }>, fallback: () => { code: number; stdout: string; stderr: string } = () => ({ code: 0, stdout: "", stderr: "" })): CommandRunner {
  return async (cmd, argv) => {
    for (const c of cases) {
      if (c.cmd === cmd && JSON.stringify(c.argv) === JSON.stringify(argv)) return c.run();
    }
    return fallback();
  };
}

describe("classifyContainerRuntime", () => {
  it("docker 不可用时按 apple container 可用性判定", () => {
    expect(classifyContainerRuntime({ dockerAvailable: false, appleContainerAvailable: true })).toBe("apple-container");
    expect(classifyContainerRuntime({ dockerAvailable: false, appleContainerAvailable: false })).toBe("none");
  });

  it("context 指纹优先于 info 字段", () => {
    expect(classifyContainerRuntime({
      dockerAvailable: true,
      contextName: "orbstack",
      infoOperatingSystem: "Docker Desktop",
      appleContainerAvailable: true,
    })).toBe("orbstack");
    expect(classifyContainerRuntime({
      dockerAvailable: true,
      contextName: "colima",
      infoOperatingSystem: "Docker Desktop",
      appleContainerAvailable: true,
    })).toBe("colima");
    expect(classifyContainerRuntime({
      dockerAvailable: true,
      contextName: "rancher-desktop",
      infoOperatingSystem: "Docker Desktop",
      appleContainerAvailable: true,
    })).toBe("rancher-desktop");
  });

  it("info OperatingSystem 识别 Docker Desktop", () => {
    expect(classifyContainerRuntime({
      dockerAvailable: true,
      infoOperatingSystem: "Docker Desktop 4.30",
      appleContainerAvailable: false,
    })).toBe("docker-desktop");
  });

  it("socket 路径回退识别 orbstack/colima，最后兜底 docker-generic", () => {
    expect(classifyContainerRuntime({
      dockerAvailable: true,
      socketPath: "/Users/x/.orbstack/run/docker.sock",
      appleContainerAvailable: false,
    })).toBe("orbstack");
    expect(classifyContainerRuntime({
      dockerAvailable: true,
      socketPath: "/Users/x/.colima/default/docker.sock",
      appleContainerAvailable: false,
    })).toBe("colima");
    expect(classifyContainerRuntime({
      dockerAvailable: true,
      appleContainerAvailable: false,
    })).toBe("docker-generic");
  });
});

describe("detectContainerRuntime", () => {
  it("docker 可用 + context=orbstack → orbstack", async () => {
    const runner = fakeRunner([
      { cmd: "docker", argv: ["version"], run: () => ({ code: 0, stdout: "Docker", stderr: "" }) },
      { cmd: "docker", argv: ["context", "show"], run: () => ({ code: 0, stdout: "orbstack\n", stderr: "" }) },
    ]);
    const result = await detectContainerRuntime(runner);
    expect(result.runtime).toBe("orbstack");
    expect(result.evidence.join(" ")).toContain("context=orbstack");
  });

  it("docker 不可用 + container 可用 → apple-container", async () => {
    const runner = fakeRunner([
      { cmd: "docker", argv: ["version"], run: () => ({ code: 1, stdout: "", stderr: "no docker" }) },
      { cmd: "container", argv: ["--version"], run: () => ({ code: 0, stdout: "container 1.0", stderr: "" }) },
    ]);
    const result = await detectContainerRuntime(runner);
    expect(result.runtime).toBe("apple-container");
  });

  it("docker 与 container 都不可用 → none", async () => {
    const runner = fakeRunner([
      { cmd: "docker", argv: ["version"], run: () => ({ code: 1, stdout: "", stderr: "no docker" }) },
      { cmd: "container", argv: ["--version"], run: () => ({ code: 1, stdout: "", stderr: "no container" }) },
    ]);
    const result = await detectContainerRuntime(runner);
    expect(result.runtime).toBe("none");
  });
});

describe("runtimeCapabilities", () => {
  it("静态能力表快照", () => {
    expect(runtimeCapabilities("docker-desktop")).toEqual({ compose: true, hostGateway: "yes" });
    expect(runtimeCapabilities("orbstack")).toEqual({ compose: true, hostGateway: "yes" });
    expect(runtimeCapabilities("colima")).toEqual({ compose: true, hostGateway: "colima-caveat" });
    expect(runtimeCapabilities("apple-container")).toEqual({ compose: false, hostGateway: "no" });
    expect(runtimeCapabilities("none")).toEqual({ compose: false, hostGateway: "no" });
  });
});
