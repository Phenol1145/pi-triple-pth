/**
 * contracts/capability-catalog.ts — TCE 网络 V1 能力/实现/Execute 路由契约。
 *
 * 对应 V1 架构报告 §5.3 与 §11：CapabilityDefinition、CapabilityImplementation、
 * ExecuteServiceDefinition、ExecuteBindingRef 与 deployment/effective catalog snapshot。
 * 本文件只承载类型与静态常量，不产生授权。
 */

import type {
  NetworkOperationProfileIdV1,
} from "./network-information.js";

// ─── Capability definition ──────────────────────────────────────────

export type CapabilityEffectV1 = "pure" | "read-external" | "write-artifact" | "admin";

export interface CapabilityDefinitionV1 {
  readonly id: string;
  readonly contractVersion: string;
  readonly inputSchemaRef: string;
  readonly outputSchemaRef: string;
  readonly effect: CapabilityEffectV1;
  readonly discoveryChannels: {
    readonly ptc: boolean;
    readonly tool: "required" | "optional" | "forbidden";
    readonly prompt: boolean;
  };
}

// ─── Orchestration surface / Execute binding ────────────────────────

export type OrchestrationHostLanguageIdV1 = "ts"; // V1 当前事实，不是目标态枚举

export type ExecuteBindingRefV1 =
  | { readonly kind: "execute-service"; readonly serviceId: string; readonly portVersion: string }
  | { readonly kind: "execution-target"; readonly targetId: string };

export interface ExecuteServiceDefinitionV1 {
  readonly id: string;
  readonly portContractVersion: string;
  readonly operationKinds: readonly string[];
  readonly implementationLanguageId?: string;
}

export interface CapabilityImplementationV1 {
  readonly implementationId: string;
  readonly capabilityId: string;
  readonly implementationVersion: string;
  readonly callableFrom: readonly OrchestrationHostLanguageIdV1[];
  readonly implementationLanguageId?: string;
  readonly executeBinding: ExecuteBindingRefV1;
  readonly providerId?: string;
  readonly supportedProfiles: readonly NetworkOperationProfileIdV1[];
  readonly capabilities: {
    readonly rawHits?: boolean;
    readonly cursor?: boolean;
    readonly remoteFetch?: boolean;
    readonly deterministicExtract?: boolean;
  };
}

export interface OrchestrationSurfaceDefinitionV1 {
  readonly id: "ts";
  readonly codeHost: "kernel-ts";
  readonly strengths: readonly string[];
}

export interface CapabilityInvocationBindingV1 {
  readonly capabilityId: string;
  readonly orchestrationSurfaceId: "ts";
  readonly invocation: "host" | "typed-proxy" | "tool-projection";
  readonly implementationId: string;
}

export interface DeploymentCapabilityCatalogSnapshotV1 {
  readonly schemaVersion: "deployment-capability-catalog/v1";
  readonly version: string;
  readonly orchestrationSurfaces: readonly OrchestrationSurfaceDefinitionV1[];
  readonly capabilities: readonly CapabilityDefinitionV1[];
  readonly implementations: readonly CapabilityImplementationV1[];
  readonly bindings: readonly CapabilityInvocationBindingV1[];
  readonly executeServices: readonly ExecuteServiceDefinitionV1[];
  readonly executionTargetIds: readonly string[];
}

export interface EffectiveCapabilityCatalogSnapshotV1 {
  readonly schemaVersion: "effective-capability-catalog/v1";
  readonly version: string;
  readonly deploymentCatalogVersion: string;
  readonly taskId: string;
  readonly roleId: string;
  readonly roleRevision: string;
  readonly profileId: "search-public";
  readonly grantId: string;
  readonly authorizedCapabilityIds: readonly string[];
  readonly eligibleImplementationIds: readonly string[];
  readonly availabilityDecisionRef: string;
  readonly observedAt: string;
}

// ─── V1 初始静态目录（fake/typed proxy 阶段；真实 provider 在 Wave 2 接入） ──

export const NETWORK_CAPABILITY_DEFINITIONS: readonly CapabilityDefinitionV1[] = [
  {
    id: "net.search",
    contractVersion: "v1",
    inputSchemaRef: "net.search.request/v1",
    outputSchemaRef: "net.search.response/v1",
    effect: "read-external",
    discoveryChannels: { ptc: true, tool: "required", prompt: true },
  },
  {
    id: "net.fetch",
    contractVersion: "v1",
    inputSchemaRef: "net.fetch.request/v1",
    outputSchemaRef: "net.fetch.response/v1",
    effect: "read-external",
    discoveryChannels: { ptc: true, tool: "required", prompt: true },
  },
  {
    id: "net.extract",
    contractVersion: "v1",
    inputSchemaRef: "net.extract.request/v1",
    outputSchemaRef: "net.document/v1",
    effect: "pure",
    discoveryChannels: { ptc: true, tool: "required", prompt: true },
  },
] as const;

export const NETWORK_EXECUTE_SERVICES: readonly ExecuteServiceDefinitionV1[] = [
  {
    id: "network-broker",
    portContractVersion: "net.broker/v1",
    operationKinds: ["search", "fetch"],
    implementationLanguageId: "ts",
  },
  {
    id: "extractor",
    portContractVersion: "net.extract/v1",
    operationKinds: ["extract"],
    implementationLanguageId: "ts",
  },
] as const;

export const NETWORK_CAPABILITY_IMPLEMENTATIONS: readonly CapabilityImplementationV1[] = [
  {
    implementationId: "net.search.typed-proxy-v1",
    capabilityId: "net.search",
    implementationVersion: "1.0.0",
    callableFrom: ["ts"],
    implementationLanguageId: "ts",
    executeBinding: { kind: "execute-service", serviceId: "network-broker", portVersion: "v1" },
    supportedProfiles: ["search-public"],
    capabilities: { rawHits: true, cursor: true },
  },
  {
    implementationId: "net.fetch.safe-transport-v1",
    capabilityId: "net.fetch",
    implementationVersion: "1.0.0",
    callableFrom: ["ts"],
    implementationLanguageId: "ts",
    executeBinding: { kind: "execute-service", serviceId: "network-broker", portVersion: "v1" },
    supportedProfiles: ["search-public"],
    capabilities: { remoteFetch: true },
  },
  {
    implementationId: "net.extract.offline-v1",
    capabilityId: "net.extract",
    implementationVersion: "1.0.0",
    callableFrom: ["ts"],
    implementationLanguageId: "ts",
    executeBinding: { kind: "execute-service", serviceId: "extractor", portVersion: "v1" },
    supportedProfiles: ["search-public"],
    capabilities: { deterministicExtract: true },
  },
] as const;

export const NETWORK_INVOCATION_BINDINGS: readonly CapabilityInvocationBindingV1[] = [
  { capabilityId: "net.search", orchestrationSurfaceId: "ts", invocation: "typed-proxy", implementationId: "net.search.typed-proxy-v1" },
  { capabilityId: "net.fetch", orchestrationSurfaceId: "ts", invocation: "typed-proxy", implementationId: "net.fetch.safe-transport-v1" },
  { capabilityId: "net.extract", orchestrationSurfaceId: "ts", invocation: "typed-proxy", implementationId: "net.extract.offline-v1" },
] as const;

export const NETWORK_ORCHESTRATION_SURFACE: readonly OrchestrationSurfaceDefinitionV1[] = [
  { id: "ts", codeHost: "kernel-ts", strengths: ["PTC orchestration", "typed proxy", "static audit"] },
] as const;

export function buildDeploymentCapabilityCatalogSnapshotV1(
  version: string,
  executionTargetIds: readonly string[] = [],
): DeploymentCapabilityCatalogSnapshotV1 {
  return {
    schemaVersion: "deployment-capability-catalog/v1",
    version,
    orchestrationSurfaces: NETWORK_ORCHESTRATION_SURFACE,
    capabilities: NETWORK_CAPABILITY_DEFINITIONS,
    implementations: NETWORK_CAPABILITY_IMPLEMENTATIONS,
    bindings: NETWORK_INVOCATION_BINDINGS,
    executeServices: NETWORK_EXECUTE_SERVICES,
    executionTargetIds,
  };
}
