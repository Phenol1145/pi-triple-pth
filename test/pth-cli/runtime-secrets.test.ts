import { describe, expect, it } from "vitest";
import {
  injectSecrets,
  missingSecretKeys,
  parseSecretsEnvFile,
} from "../../src/cli/runtime/runtime-secrets.js";

const SECRETS = [
  "SANDBOX_SHARED_SECRET=sandbox-secret-000000000000000000000000",
  "PTH_EXECUTION_GRANT_SECRET=grant-secret-000000000000000000000000",
  "PTH_MEMORY_BRIDGE_TOKEN=memory-bridge-token-000000000000000000",
  "POSTGRES_PASSWORD=pg-password-0000000000000000000000000000",
  "REDIS_PASSWORD=redis-password-00000000000000000000000000",
  "LOCAL_EXEC_SHARED_SECRET=local-exec-secret-00000000000000000000",
  "JUPYTER_SERVICE_TOKEN=jupyter-service-token-000000000000000000",
].join("\n");

describe("runtime-secrets", () => {
  it("解析 env-file（注释/空行/export 前缀/KEY=VALUE）", () => {
    const parsed = parseSecretsEnvFile(`# comment\n\nexport A=1\nB = 2\nbad-line\n`);
    expect(parsed).toEqual({ A: "1", B: "2" });
  });

  it("解析完整 secrets 样例", () => {
    const parsed = parseSecretsEnvFile(SECRETS);
    expect(parsed.SANDBOX_SHARED_SECRET).toContain("sandbox-secret");
    expect(parsed.JUPYTER_SERVICE_TOKEN).toContain("jupyter-service-token");
  });

  it("injectSecrets 只注入指定 keys 且不改入参", () => {
    const env = { PTH_WORKSPACES_HOST: "/tmp/x" };
    const secrets = parseSecretsEnvFile(SECRETS);
    const out = injectSecrets(env, secrets, ["JUPYTER_SERVICE_TOKEN", "JUPYTER_ENGINE_TOKEN"]);
    expect(out.JUPYTER_SERVICE_TOKEN).toBeDefined();
    expect(out.JUPYTER_ENGINE_TOKEN).toBeUndefined();
    expect(out.SANDBOX_SHARED_SECRET).toBeUndefined();
    expect(env.JUPYTER_SERVICE_TOKEN).toBeUndefined();
  });

  it("missingSecretKeys 返回缺失清单", () => {
    const secrets = parseSecretsEnvFile(SECRETS);
    expect(missingSecretKeys(secrets, ["JUPYTER_SERVICE_TOKEN", "JUPYTER_ENGINE_TOKEN"])).toEqual(["JUPYTER_ENGINE_TOKEN"]);
    expect(missingSecretKeys(secrets, ["JUPYTER_SERVICE_TOKEN"])).toEqual([]);
  });
});
