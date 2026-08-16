/**
 * agent-engine-assets.ts —— 工具面/覆盖层/版本快照辅助（模块专项 ② 大文件拆分：自 agent-engine.ts 抽出）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceManager } from "@away_from/infra";
import type { ToolPlatform } from "../tools/platform.js";
import type { VersionSnapshot, ManagedSessionInfo } from "./types.js";
import type { PoolSession } from "./session-pool.js";

export interface AgentEngineAssetHost {
  toolPlatform: ToolPlatform;
  sandboxBash?: unknown;
  workspaceMgr: WorkspaceManager;
  overlayProvider?: { getOverlayPaths(): { skills: string[]; prompts: string[] } } | null;
}

export function buildCustomToolsFor(engine: AgentEngineAssetHost, tenantId: string): any[] {
  const tools = [...engine.toolPlatform.getSdkToolDefinitions(tenantId)];
  if (engine.sandboxBash) {
    tools.push(engine.sandboxBash);
  }
  return tools;
}

export function agentDirOf(_engine: AgentEngineAssetHost): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "/", ".pi", "agent");
}

export function overlayPathsOf(engine: AgentEngineAssetHost): { skills: string[]; prompts: string[] } {
  return engine.overlayProvider?.getOverlayPaths() ?? { skills: [], prompts: [] };
}

export function versionSnapshotOf(engine: AgentEngineAssetHost): VersionSnapshot {
  const platformDir = engine.workspaceMgr.getPlatformDir();
  const skillsDir = path.join(platformDir, "skills");
  const promptsDir = path.join(platformDir, "prompts");
  const toolsDir = path.join(platformDir, "tools");
  return {
    skills: listDirHashes(skillsDir),
    prompts: listDirHashes(promptsDir),
    tools: listDirHashes(toolsDir),
    timestamp: new Date().toISOString(),
  };
}

export function managedInfoOf(s: PoolSession): ManagedSessionInfo {
  return {
    sessionId: s.sessionId,
    tenantId: s.tenantId,
    project: s.project,
    state: s.state,
    model: s.model ?? "unknown",
    createdAt: new Date(s.lastAccess).toISOString(),
    lastAccess: new Date(s.lastAccess).toISOString(),
  };
}

export function listDirHashes(dir: string): string[] {
  try {
    const files = fs.readdirSync(dir).sort();
    return files.map((f) => {
      try {
        const content = fs.readFileSync(path.join(dir, f), "utf-8");
        const h = crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
        return `${f}:${h}`;
      } catch {
        return f;
      }
    });
  } catch {
    return [];
  }
}
