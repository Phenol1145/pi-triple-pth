/**
 * runtime/targets/detect.ts —— 容器运行时指纹检测。
 *
 * 统一入口仍是 `docker` CLI；识别依据三层指纹（按序取先命中者）：
 *   1. `docker context show`（orbstack / colima / rancher-desktop）
 *   2. `docker info` OperatingSystem（Docker Desktop）
 *   3. socket 路径回退（/.orbstack/、/.colima/）
 * docker 不可用时探 `container --version`（Apple container）→ none。
 */
import type { CommandRunner } from "./types.js";

export type ContainerRuntime =
  | "docker-desktop"
  | "orbstack"
  | "colima"
  | "rancher-desktop"
  | "docker-generic"
  | "apple-container"
  | "none";

export const CONTAINER_RUNTIMES: readonly ContainerRuntime[] = [
  "docker-desktop",
  "orbstack",
  "colima",
  "rancher-desktop",
  "docker-generic",
  "apple-container",
  "none",
];

export interface ClassifyContainerRuntimeInput {
  dockerAvailable: boolean;
  contextName?: string;
  socketPath?: string;
  infoOperatingSystem?: string;
  appleContainerAvailable: boolean;
}

export function classifyContainerRuntime(input: ClassifyContainerRuntimeInput): ContainerRuntime {
  if (!input.dockerAvailable) {
    return input.appleContainerAvailable ? "apple-container" : "none";
  }
  const context = input.contextName?.trim().toLowerCase() ?? "";
  if (context.includes("orbstack")) return "orbstack";
  if (context.startsWith("colima") || context.includes("colima")) return "colima";
  if (context.includes("rancher-desktop")) return "rancher-desktop";
  if ((input.infoOperatingSystem ?? "").toLowerCase().includes("docker desktop")) return "docker-desktop";
  const socket = input.socketPath?.toLowerCase() ?? "";
  if (socket.includes("/.orbstack/")) return "orbstack";
  if (socket.includes("/.colima/")) return "colima";
  return "docker-generic";
}

export interface ContainerRuntimeCapabilities {
  compose: boolean;
  hostGateway: "yes" | "colima-caveat" | "no";
}

/** 设计 §5.2 能力静态表；doctor 据此生成检查项。 */
export function runtimeCapabilities(runtime: ContainerRuntime): ContainerRuntimeCapabilities {
  switch (runtime) {
    case "docker-desktop":
    case "rancher-desktop":
      return { compose: true, hostGateway: "yes" };
    case "orbstack":
      return { compose: true, hostGateway: "yes" };
    case "colima":
      return { compose: true, hostGateway: "colima-caveat" };
    case "docker-generic":
      return { compose: true, hostGateway: "yes" };
    case "apple-container":
      return { compose: false, hostGateway: "no" };
    case "none":
      return { compose: false, hostGateway: "no" };
  }
}

export async function detectContainerRuntime(runner: CommandRunner): Promise<{
  runtime: ContainerRuntime;
  evidence: string[];
}> {
  const evidence: string[] = [];
  const docker = await runner("docker", ["version"]);
  if (docker.code === 0) {
    evidence.push("docker version ok");
    const context = await runner("docker", ["context", "show"]);
    const contextName = context.code === 0 ? context.stdout.trim() : undefined;
    if (contextName) evidence.push(`context=${contextName}`);

    const info = await runner("docker", ["info", "--format", "{{json .}}"]);
    let infoOperatingSystem: string | undefined;
    if (info.code === 0 && info.stdout.trim()) {
      try {
        const parsed = JSON.parse(info.stdout) as { OperatingSystem?: string };
        infoOperatingSystem = parsed.OperatingSystem;
        if (infoOperatingSystem) evidence.push(`os=${infoOperatingSystem}`);
      } catch {
        evidence.push("docker info json parse failed");
      }
    }

    const socketPath = process.env.DOCKER_HOST;
    if (socketPath) evidence.push(`socket=${socketPath}`);

    const runtime = classifyContainerRuntime({
      dockerAvailable: true,
      contextName,
      socketPath,
      infoOperatingSystem,
      appleContainerAvailable: false,
    });
    evidence.push(`runtime=${runtime}`);
    return { runtime, evidence };
  }

  evidence.push("docker unavailable");
  const apple = await runner("container", ["--version"]);
  const appleContainerAvailable = apple.code === 0;
  if (appleContainerAvailable) evidence.push("apple container available");
  const runtime = classifyContainerRuntime({
    dockerAvailable: false,
    appleContainerAvailable,
  });
  evidence.push(`runtime=${runtime}`);
  return { runtime, evidence };
}
