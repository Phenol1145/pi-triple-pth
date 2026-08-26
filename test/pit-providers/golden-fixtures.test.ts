import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateProvider } from "../../extensions/pit-providers/registry.js";
import { loadProviders } from "../../extensions/pit-providers/registry.js";

const GOLDEN_DIR = path.resolve(process.cwd(), "test/fixtures/providers/golden");

let tmpDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pit-providers-golden-"));
  originalHome = process.env.PI_TRIPLE_HOME;
  process.env.PI_TRIPLE_HOME = tmpDir;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PI_TRIPLE_HOME;
  else process.env.PI_TRIPLE_HOME = originalHome;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function readFixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, name), "utf8"));
}

describe("pit-providers golden fixtures conformance", () => {
  it("valid fixtures pass validateProvider and preserve unknown fields", () => {
    for (const name of ["valid-defaults.json", "valid-unknown-fields.json"]) {
      const doc = readFixture(name);
      for (const provider of doc.providers) {
        const result = validateProvider(provider);
        expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
        if (!result.ok) continue;
        // 保真：校验通过后不得重建对象丢弃未知字段
        if (provider["x-vendor"] !== undefined) {
          expect((result.def as any)["x-vendor"]).toBe(provider["x-vendor"]);
        }
        for (const [mi, m] of (provider.models ?? []).entries()) {
          if (m["x-model-tag"] !== undefined) {
            expect((result.def.models[mi] as any)["x-model-tag"]).toBe(m["x-model-tag"]);
          }
        }
      }
    }
  });

  it("valid fixtures can be loaded by loadProviders without dropping unknown fields", async () => {
    for (const name of ["valid-defaults.json", "valid-unknown-fields.json"]) {
      await fsp.writeFile(path.join(tmpDir, "providers.json"), JSON.stringify(readFixture(name)), "utf8");
      const { providers, errors } = loadProviders();
      expect(errors).toEqual([]);
      expect(providers.length).toBeGreaterThan(0);
      if (name === "valid-unknown-fields.json") {
        expect((providers[0] as any)["x-vendor"]).toBe("acme");
        expect((providers[0]!.models[0] as any)["x-model-tag"]).toBe("beta");
      }
    }
  });

  it("invalid fixtures are rejected by validateProvider or global namespace detection", async () => {
    const badId = readFixture("invalid-bad-id.json").providers[0];
    expect(validateProvider(badId).ok).toBe(false);

    const badUrl = readFixture("invalid-bad-base-url.json").providers[0];
    expect(validateProvider(badUrl).ok).toBe(false);

    for (const name of [
      "invalid-empty-api.json",
      "invalid-empty-name.json",
      "invalid-empty-model-id.json",
      "invalid-empty-alias.json",
      "invalid-alias-not-string.json",
    ]) {
      expect(validateProvider(readFixture(name).providers[0]).ok, name).toBe(false);
    }

    // 全局名字空间冲突（alias 与 id 冲突）由 loadProviders 拒绝
    for (const name of [
      "invalid-alias-collides-with-id.json",
      "invalid-duplicate-alias.json",
    ]) {
      await fsp.writeFile(path.join(tmpDir, "providers.json"), JSON.stringify(readFixture(name)), "utf8");
      const { providers, errors } = loadProviders();
      expect(errors.length).toBeGreaterThan(0);
      expect(providers).toEqual([]);
    }
  });

  it("rejects duplicate alias inside one provider and alias equal to own id", async () => {
    const base = {
      name: "Dup",
      baseUrl: "https://dup.example.com/v1",
      api: "openai-completions",
      multiKey: false,
      refreshModels: false,
      models: [],
    };
    const docs = [
      { version: 1, providers: [{ id: "dup", alias: ["x", "x"], ...base }] },
      { version: 1, providers: [{ id: "self", alias: ["self"], ...base }] },
    ];
    for (const doc of docs) {
      await fsp.writeFile(path.join(tmpDir, "providers.json"), JSON.stringify(doc), "utf8");
      const { providers, errors } = loadProviders();
      expect(errors.length).toBeGreaterThan(0);
      expect(providers).toEqual([]);
    }
  });

  it("strict mode rejects whole file when any provider is invalid", async () => {
    const doc = {
      version: 1,
      providers: [
        readFixture("valid-defaults.json").providers[0],
        readFixture("invalid-bad-base-url.json").providers[0],
      ],
    };
    await fsp.writeFile(path.join(tmpDir, "providers.json"), JSON.stringify(doc), "utf8");
    const { providers, errors } = loadProviders();
    expect(errors.length).toBeGreaterThan(0);
    expect(providers).toEqual([]);
  });
});
