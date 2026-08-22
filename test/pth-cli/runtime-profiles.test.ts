import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RUNTIME_PROFILES,
  RUNTIME_PROFILE_VERSION,
  resolveProfile,
  validateRuntimeProfiles,
  type RuntimeProfilesFile,
} from "../../src/cli/runtime/runtime-profiles.js";

const profilesPath = fileURLToPath(new URL("../../deploy/runtime-profiles.json", import.meta.url));

describe("deploy/runtime-profiles.json", () => {
  it("文件与 DEFAULT_RUNTIME_PROFILES 一致且通过校验", async () => {
    const text = await readFile(profilesPath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    const validated = validateRuntimeProfiles(parsed);
    expect(validated).toEqual(DEFAULT_RUNTIME_PROFILES);
    expect(validated.version).toBe(RUNTIME_PROFILE_VERSION);
  });
});

describe("validateRuntimeProfiles", () => {
  const file = () => structuredClone(DEFAULT_RUNTIME_PROFILES) as RuntimeProfilesFile;

  it("core 展开 = 数据层 + engine（engine 最后）", () => {
    const r = resolveProfile(file(), "core");
    expect(r.components.map((c) => c.id)).toEqual(["redis", "postgres", "sandbox", "engine"]);
  });

  it("full 展开按稳定顺序且去重", () => {
    const r = resolveProfile(file(), "full");
    expect(r.components.map((c) => c.id)).toEqual(["redis", "postgres", "sandbox", "tools", "local-lean", "local-u8", "jupyter", "engine"]);
  });

  it("jupyter profile 展开 = core + jupyter", () => {
    const r = resolveProfile(file(), "jupyter");
    expect(r.components.map((c) => c.id)).toEqual(["redis", "postgres", "sandbox", "jupyter", "engine"]);
  });

  it("--with 支持 component id 与 profile 名并去重", () => {
    const r = resolveProfile(file(), "core", { withIds: ["jupyter", "lean4"] });
    expect(r.components.map((c) => c.id)).toEqual(["redis", "postgres", "sandbox", "local-lean", "jupyter", "engine"]);
  });

  it("--without 移除可选组件", () => {
    const r = resolveProfile(file(), "full", { withoutIds: ["tools", "local-u8"] });
    expect(r.components.map((c) => c.id)).toEqual(["redis", "postgres", "sandbox", "local-lean", "jupyter", "engine"]);
  });

  it("--without 核心组件报错", () => {
    expect(() => resolveProfile(file(), "core", { withoutIds: ["postgres"] })).toThrow(/核心组件不允许 --without/);
    expect(() => resolveProfile(file(), "core", { withoutIds: ["engine"] })).toThrow(/核心组件不允许 --without/);
  });

  it("未知 profile/component 报错", () => {
    expect(() => resolveProfile(file(), "nope")).toThrow(/unknown profile/);
    expect(() => resolveProfile(file(), "core", { withIds: ["nope"] })).toThrow(/unknown component\/profile/);
  });

  it("非法 version / 重复 id / 缺失 engine / 未知引用 / extends 环均拒绝", () => {
    const f = file();
    f.version = 2;
    expect(() => validateRuntimeProfiles(f)).toThrow(/version 必须/);

    const dup = file();
    dup.components.push({ ...dup.components[0]! });
    expect(() => validateRuntimeProfiles(dup)).toThrow(/重复/);

    const noEngine = file();
    noEngine.components = noEngine.components.filter((c) => c.id !== "engine");
    expect(() => validateRuntimeProfiles(noEngine)).toThrow(/必须包含 engine/);

    const badRef = file();
    badRef.profiles.core!.components.push("missing");
    expect(() => validateRuntimeProfiles(badRef)).toThrow(/不存在/);

    const cycle = file();
    cycle.profiles.core!.extends = "full";
    expect(() => validateRuntimeProfiles(cycle)).toThrow(/环/);
  });

  it("kind 语义校验（compose 需 services，service 需 serviceId，pth-up 只许 engine phase）", () => {
    const badCompose = file();
    badCompose.components[0]!.services = undefined;
    expect(() => validateRuntimeProfiles(badCompose)).toThrow(/services/);

    const badService = file();
    badService.components.find((c) => c.id === "jupyter")!.serviceId = undefined;
    expect(() => validateRuntimeProfiles(badService)).toThrow(/serviceId/);

    const badPth = file();
    badPth.components.find((c) => c.id === "engine")!.phase = "data";
    expect(() => validateRuntimeProfiles(badPth)).toThrow(/phase=engine/);
  });
});
