import { describe, expect, it } from "vitest";
import { buildWorkloadEnv, workloadIdentity } from "@away_from/pth-sandbox";

/** P0-2：工作负载 env 必须 allowlist 构造，控制器凭据不得进入 workload */
describe("workload environment allowlist（P0-2）", () => {
  it("不继承控制器密钥与连接串", () => {
    process.env.SANDBOX_SHARED_SECRET = "secret";
    process.env.PTH_MEMORY_BRIDGE_TOKEN = "bridge";
    process.env.DATABASE_URL = "postgresql://secret";
    process.env.REDIS_URL = "redis://secret";
    process.env.PI_OPENAI_API_KEY = "sk-secret";
    const env = buildWorkloadEnv({ PTH_MEMORY_BRIDGE: "http://localhost:8080/kernel/memory-bridge" });
    expect(env.SANDBOX_SHARED_SECRET).toBeUndefined();
    expect(env.PTH_MEMORY_BRIDGE_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.PI_OPENAI_API_KEY).toBeUndefined();
    expect(env.PTH_MEMORY_BRIDGE).toBe("http://localhost:8080/kernel/memory-bridge");
    delete process.env.SANDBOX_SHARED_SECRET;
    delete process.env.PTH_MEMORY_BRIDGE_TOKEN;
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    delete process.env.PI_OPENAI_API_KEY;
  });

  it("override 尝试注入密钥也被强制剔除（纵深防御）", () => {
    const env = buildWorkloadEnv({ SANDBOX_SHARED_SECRET: "forged" });
    expect(env.SANDBOX_SHARED_SECRET).toBeUndefined();
  });

  it("PTH_MEMORY_BRIDGE_TOKEN 仅显式 trusted 时放行", () => {
    const blocked = buildWorkloadEnv({ PTH_MEMORY_BRIDGE_TOKEN: "bridge" });
    expect(blocked.PTH_MEMORY_BRIDGE_TOKEN).toBeUndefined();
    const trusted = buildWorkloadEnv({ PTH_MEMORY_BRIDGE_TOKEN: "bridge" }, { allowBridgeToken: true });
    expect(trusted.PTH_MEMORY_BRIDGE_TOKEN).toBe("bridge");
  });

  it("保留语言运行时必需的基础键", () => {
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/home/x";
    const env = buildWorkloadEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    delete process.env.PATH;
    delete process.env.HOME;
  });

  it("workloadIdentity 仅从显式 env 读取（宿主默认当前用户）", () => {
    delete process.env.PTH_WORKLOAD_UID;
    delete process.env.PTH_WORKLOAD_GID;
    expect(workloadIdentity()).toEqual({});
    process.env.PTH_WORKLOAD_UID = "2001";
    process.env.PTH_WORKLOAD_GID = "2001";
    expect(workloadIdentity()).toEqual({ uid: 2001, gid: 2001 });
    delete process.env.PTH_WORKLOAD_UID;
    delete process.env.PTH_WORKLOAD_GID;
  });
});
