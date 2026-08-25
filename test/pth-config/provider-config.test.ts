import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  providersPath,
  validateProvidersDoc,
  validateProvider,
  normalizeProviderInput,
  loadProvidersFile,
  saveProvidersFile,
  backupProvidersFile,
  restoreProvidersFile,
  addProviderToDoc,
  updateProviderInDoc,
  removeProviderFromDoc,
  getProvider,
} from "@away_from/pth-config";

const GOLDEN_DIR = path.resolve(process.cwd(), "test/fixtures/providers/golden");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pth-provider-config-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function fixture(name: string): string {
  return path.join(GOLDEN_DIR, name);
}

function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(fixture(name), "utf8"));
}

describe("validateProvidersDoc", () => {
  it("accepts valid golden fixture", () => {
    const result = validateProvidersDoc(readFixture("valid-defaults.json"));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("preserves unknown fields during validation", () => {
    const result = validateProvidersDoc(readFixture("valid-unknown-fields.json"));
    expect(result.ok).toBe(true);
  });

  it("rejects duplicate alias", () => {
    const result = validateProvidersDoc(readFixture("invalid-duplicate-alias.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("alias");
  });

  it("rejects alias colliding with an existing provider id", () => {
    const result = validateProvidersDoc(readFixture("invalid-alias-collides-with-id.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("alpha");
  });

  it("rejects empty and non-string alias elements", () => {
    expect(validateProvidersDoc(readFixture("invalid-empty-alias.json")).ok).toBe(false);
    expect(validateProvidersDoc(readFixture("invalid-alias-not-string.json")).ok).toBe(false);
  });

  it("rejects empty required strings and empty model id", () => {
    expect(validateProvidersDoc(readFixture("invalid-empty-api.json")).ok).toBe(false);
    expect(validateProvidersDoc(readFixture("invalid-empty-name.json")).ok).toBe(false);
    expect(validateProvidersDoc(readFixture("invalid-empty-model-id.json")).ok).toBe(false);
  });

  it("rejects duplicate alias inside the same provider", () => {
    const result = validateProvidersDoc({
      version: 1,
      providers: [{
        id: "dup",
        name: "Dup",
        alias: ["x", "x"],
        baseUrl: "https://dup.example.com/v1",
        api: "openai-completions",
        multiKey: false,
        refreshModels: false,
        models: [],
      }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("x");
  });

  it("rejects bad provider id", () => {
    const result = validateProvidersDoc(readFixture("invalid-bad-id.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("id");
  });

  it("rejects non-http baseUrl", () => {
    const result = validateProvidersDoc(readFixture("invalid-bad-base-url.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("baseUrl");
  });
});

describe("normalizeProviderInput", () => {
  it("fills defaults for add", () => {
    const result = normalizeProviderInput({
      id: "local",
      name: "Local",
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.def.api).toBe("openai-completions");
    expect(result.def.multiKey).toBe(false);
    expect(result.def.refreshModels).toBe(false);
    expect(result.def.models).toEqual([]);
  });

  it("rejects invalid id", () => {
    const result = normalizeProviderInput({ id: "Bad ID", name: "x", baseUrl: "http://x" });
    expect(result.ok).toBe(false);
  });
});

describe("doc operations", () => {
  const baseDoc = { version: 1 as const, providers: [] };
  const provider = {
    id: "local",
    name: "Local",
    baseUrl: "http://127.0.0.1:11434/v1",
    api: "openai-completions",
    multiKey: false,
    refreshModels: false,
    models: [],
  };

  it("add/get/update/remove", () => {
    const added = addProviderToDoc(baseDoc, provider);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(getProvider(added.value.doc, "local")?.name).toBe("Local");

    const updated = updateProviderInDoc(added.value.doc, "local", { baseUrl: "http://127.0.0.1:1234/v1" });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(getProvider(updated.value.doc, "local")?.baseUrl).toBe("http://127.0.0.1:1234/v1");

    const removed = removeProviderFromDoc(updated.value.doc, "local");
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.doc.providers).toHaveLength(0);
  });

  it("id is immutable", () => {
    const added = addProviderToDoc(baseDoc, provider);
    if (!added.ok) throw new Error("add failed");
    const updated = updateProviderInDoc(added.value.doc, "local", { id: "other" } as any);
    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect(updated.error.code).toBe("PROVIDER_ID_IMMUTABLE");
  });

  it("models are replaced wholesale", () => {
    const added = addProviderToDoc(baseDoc, provider);
    if (!added.ok) throw new Error("add failed");
    const updated = updateProviderInDoc(added.value.doc, "local", {
      models: [{ id: "m2", name: "M2" }],
    } as any);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.doc.providers[0]!.models.map((m) => m.id)).toEqual(["m2"]);
  });
});

describe("file save/load/backup/restore", () => {
  it("saves and loads a file", async () => {
    const file = path.join(tmpDir, "providers.json");
    const doc = { version: 1 as const, providers: [{
      id: "local",
      name: "Local",
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "openai-completions",
      multiKey: false,
      refreshModels: false,
      models: [],
    }] };

    const saved = await saveProvidersFile(doc, file, { backup: false });
    expect(saved.ok).toBe(true);
    const loaded = loadProvidersFile(file);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.providers[0]!.id).toBe("local");
  });

  it("creates backup on save by default", async () => {
    const file = path.join(tmpDir, "providers.json");
    const doc = { version: 1 as const, providers: [] };
    await saveProvidersFile(doc, file, { backup: false });
    doc.providers.push({
      id: "local",
      name: "Local",
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "openai-completions",
      multiKey: false,
      refreshModels: false,
      models: [],
    });
    const saved = await saveProvidersFile(doc, file, { backup: true });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.backupPath).toBeTruthy();
    expect(fs.existsSync(saved.value.backupPath!)).toBe(true);
  });

  it("backup/restore round trip", async () => {
    const file = path.join(tmpDir, "providers.json");
    const doc = { version: 1 as const, providers: [{
      id: "a",
      name: "A",
      baseUrl: "http://a.example.com/v1",
      api: "openai-completions",
      multiKey: false,
      refreshModels: false,
      models: [],
    }] };
    await saveProvidersFile(doc, file, { backup: false });

    const backup = await backupProvidersFile(file);
    expect(backup.ok).toBe(true);
    if (!backup.ok) return;
    const backupPath = backup.value.path;

    doc.providers.push({
      id: "b",
      name: "B",
      baseUrl: "http://b.example.com/v1",
      api: "openai-completions",
      multiKey: false,
      refreshModels: false,
      models: [],
    });
    await saveProvidersFile(doc, file, { backup: true });

    const restored = await restoreProvidersFile(backupPath, file, { backup: false });
    expect(restored.ok).toBe(true);
    const loaded = loadProvidersFile(file);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.providers.map((p) => p.id)).toEqual(["a"]);
  });

  it("rejects symlink target", async () => {
    const real = path.join(tmpDir, "real.json");
    const link = path.join(tmpDir, "link.json");
    await fsp.writeFile(real, JSON.stringify({ version: 1, providers: [] }), "utf8");
    await fsp.symlink(real, link);

    const doc = { version: 1 as const, providers: [] };
    const result = await saveProvidersFile(doc, link, { backup: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FILE_NOT_REGULAR");
  });

  it("CAS detects concurrent modification", async () => {
    const file = path.join(tmpDir, "providers.json");
    const doc = { version: 1 as const, providers: [] };
    await saveProvidersFile(doc, file, { backup: false });

    // 模拟另一个进程修改了文件
    await fsp.writeFile(file, JSON.stringify({ version: 1, providers: [] }), "utf8");

    const result = await saveProvidersFile(doc, file, { backup: false, expectedHash: "deadbeef" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONCURRENT_MODIFICATION");
  });

  it("CAS prevents lost update on first creation", async () => {
    const file = path.join(tmpDir, "providers.json");
    const makeDoc = (id: string) => ({ version: 1 as const, providers: [{
      id,
      name: id.toUpperCase(),
      baseUrl: `https://${id}.example.com/v1`,
      api: "openai-completions",
      multiKey: false,
      refreshModels: false,
      models: [],
    }] });

    const results = await Promise.all([
      saveProvidersFile(makeDoc("a"), file, { backup: false, expectedHash: null }),
      saveProvidersFile(makeDoc("b"), file, { backup: false, expectedHash: null }),
    ]);

    const okResults = results.filter((r) => r.ok);
    const failedResults = results.filter((r) => !r.ok);
    expect(okResults).toHaveLength(1);
    expect(failedResults).toHaveLength(1);
    if (!failedResults[0]?.ok) {
      expect(failedResults[0]!.error.code).toBe("CONCURRENT_MODIFICATION");
    }

    const loaded = loadProvidersFile(file);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.providers).toHaveLength(1);
  });

  it("preserves unknown fields on round trip", async () => {
    const file = path.join(tmpDir, "providers.json");
    const raw = readFixture("valid-unknown-fields.json") as any;
    await saveProvidersFile(raw, file, { backup: false });
    const loaded = loadProvidersFile(file);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.providers[0]!["x-vendor"]).toBe("acme");
    expect(loaded.value.providers[0]!.models[0]!["x-model-tag"]).toBe("beta");
  });
});

describe("golden fixtures conformance", () => {
  it("all valid fixtures can be loaded and saved", async () => {
    for (const name of ["valid-defaults.json", "valid-unknown-fields.json"]) {
      const file = path.join(tmpDir, name);
      await fsp.writeFile(file, JSON.stringify(readFixture(name)), "utf8");
      const loaded = loadProvidersFile(file);
      expect(loaded.ok).toBe(true);
    }
  });
});
