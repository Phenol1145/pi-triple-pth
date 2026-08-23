export interface WorkflowDefinition {
  id: string;
  name: string;
  contentHash: string;
  steps: WorkflowStep[];
}

export type WorkflowStep =
  | { type: "agent"; index: number; agentConfig: { project: string; provider?: string; model?: string }; prompt: string; idempotencyKey: string }
  | { type: "parallel"; index: number; branches: WorkflowStep[][]; concurrency: number; failStrategy: "fail-fast" | "all-settled" }
  | { type: "condition"; index: number; predicate: Record<string, unknown>; then: WorkflowStep; else?: WorkflowStep }
  | { type: "human-approval"; index: number; question: string; timeoutMs: number };

export interface WorkflowState {
  workflowId: string;
  definitionHash: string;
  tenantId: string;
  status: "running" | "awaiting_approval" | "completed" | "failed";
  completedSteps: number[];
  stepResults: Record<number, unknown>;
  currentStep: number;
  fencingToken: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowIntent {
  type: "run-agent";
  tenantId: string;
  project: string;
  prompt: string;
  idempotencyKey: string;
}
