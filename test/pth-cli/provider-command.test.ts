import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configProviderCommand } from "../../src/cli/provider-command.js";

let tmpDir: string;
let originalHome: string | undefined;
let originalReadonly: string | undefined;
let originalProviderWrite: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pth-provider-cli-"));
  originalHome = process.env.PI_TRIPLE_HOME;
  originalReadonly = process.env.PTH_CONFIG_READONLY;
  originalProviderWrite = process.env.PTH_PROVIDER_WRITE;
  process.env.PI_TRIPLE_HOME = tmpDir;
  delete process.env.PTH_CONFIG_READONLY;
  delete process.env.PTH_PROVIDER_WRITE;
  process.exitCode = 0;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PI_TRIPLE_HOME;
  else process.env.PI_TRIPLE_HOME = originalHome;
  if (originalReadonly === undefined) delete process.env.PTH_CONFIG_READONLY;
  else process.env.PTH_CONFIG_READONLY = originalReadonly;
  if (originalProviderWrite === undefined) delete process.env.PTH_PROVIDER_WRITE;
  else process.env.PTH_PROVIDER_WRITE = originalProviderWrite;
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.exitCode = 0;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function providersFile(): string {
  return path.join(tmpDir, "providers.json");
}

function readProviders(): any {
  return JSON.parse(fs.readFileSync(providersFile(), "utf8"));
}

const localProvider = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  models: [{ id: "m", name: "M" }],
};

describe("pth config provider CLI", () => {
  it("list returns empty when file missing", async () => {
    await configProviderCommand(["list", "--json"]);
    expect(process.exitCode).toBe(0);
    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(output.ok).toBe(true);
    expect(output.providers).toEqual([]);
  });

  it("add writes provider and list reads it", async () => {
    await configProviderCommand(["add", "--data", JSON.stringify(localProvider), "--json"]);
    expect(process.exitCode).toBe(0);
    expect(fs.existsSync(providersFile())).toBe(true);
    expect(readProviders().providers).toHaveLength(1);

    await configProviderCommand(["list", "--json"]);
    const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(output.providers[0].id).toBe("local");
  });

  it("update changes baseUrl", async () => {
    await configProviderCommand(["add", "--data", JSON.stringify(localProvider), "--json"]);
    await configProviderCommand(["update", "local", "--data", JSON.stringify({ baseUrl: "http://127.0.0.1:1234/v1" }), "--json"]);
    expect(process.exitCode).toBe(0);
    expect(readProviders().providers[0].baseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("remove deletes provider", async () => {
    await configProviderCommand(["add", "--data", JSON.stringify(localProvider), "--json"]);
    await configProviderCommand(["remove", "local", "--yes", "--json"]);
    expect(process.exitCode).toBe(0);
    expect(readProviders().providers).toHaveLength(0);
  });

  it("unknown action is usage error", async () => {
    await configProviderCommand(["frobnicate"]);
    expect(process.exitCode).toBe(2);
  });

  it("test is not implemented", async () => {
    await configProviderCommand(["test", "local", "--json"]);
    expect(process.exitCode).toBe(1);
    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("PTH_CONFIG_READONLY blocks writes but allows list", async () => {
    process.env.PTH_CONFIG_READONLY = "1";
    await configProviderCommand(["add", "--data", JSON.stringify(localProvider), "--json"]);
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(providersFile())).toBe(false);

    process.exitCode = 0;
    await configProviderCommand(["list", "--json"]);
    expect(process.exitCode).toBe(0);
  });

  it("PTH_PROVIDER_WRITE=0 blocks writes", async () => {
    process.env.PTH_PROVIDER_WRITE = "0";
    await configProviderCommand(["add", "--data", JSON.stringify(localProvider), "--json"]);
    expect(process.exitCode).toBe(1);
    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(output.error.code).toBe("PROVIDER_WRITE_DISABLED");
  });

  it("business failure exits 1 with JSON body", async () => {
    await configProviderCommand(["get", "missing", "--json"]);
    expect(process.exitCode).toBe(1);
    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe("PROVIDER_NOT_FOUND");
  });

  it("backup and restore round trip", async () => {
    await configProviderCommand(["add", "--data", JSON.stringify(localProvider), "--json"]);
    await configProviderCommand(["backup", "--json"]);
    expect(process.exitCode).toBe(0);
    const backupOutput = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(backupOutput.ok).toBe(true);
    const backupPath = backupOutput.path;

    await configProviderCommand(["add", "--data", JSON.stringify({ ...localProvider, id: "second", name: "Second" }), "--json"]);
    expect(readProviders().providers).toHaveLength(2);

    await configProviderCommand(["restore", backupPath, "--yes", "--json"]);
    expect(process.exitCode).toBe(0);
    expect(readProviders().providers.map((p: any) => p.id)).toEqual(["local"]);
  });
});
