/**
 * interaction/task-draft-service.ts —— N25 TaskDraft 服务（内存实现，v1）。
 *
 * 提供 Draft 版本化、质量门与提交证明；生产化时替换为 PG 持久化。
 */

import { createHash, randomUUID } from "node:crypto";
import type { TaskDraft, TaskDraftSubmission, QualityGateResult } from "@away_from/pth-contracts";

export interface CreateTaskDraftInput {
  tenantId: string;
  principalId: string;
  title: string;
  text: string;
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class TaskDraftService {
  private readonly drafts = new Map<string, TaskDraft>();

  create(input: CreateTaskDraftInput): TaskDraft {
    const now = new Date().toISOString();
    const draft: TaskDraft = {
      id: randomUUID(),
      revision: 1,
      tenantId: input.tenantId,
      principalId: input.principalId,
      title: input.title,
      text: input.text,
      status: "draft",
      createdAt: now,
      updatedAt: now,
      contentHash: contentHash(input.text),
    };
    this.drafts.set(draft.id, draft);
    return draft;
  }

  get(id: string): TaskDraft | undefined {
    return this.drafts.get(id);
  }

  update(id: string, patch: { title?: string; text?: string }): TaskDraft | undefined {
    const current = this.drafts.get(id);
    if (!current) return undefined;
    const updated: TaskDraft = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.text !== undefined ? { text: patch.text, contentHash: contentHash(patch.text) } : {}),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.drafts.set(id, updated);
    return updated;
  }

  runQualityGate(id: string): QualityGateResult | undefined {
    const draft = this.drafts.get(id);
    if (!draft) return undefined;
    const checks: string[] = [];
    const failures: string[] = [];
    if (draft.title.trim().length > 0) checks.push("title-nonempty");
    else failures.push("title-nonempty");
    if (draft.text.trim().length > 0) checks.push("text-nonempty");
    else failures.push("text-nonempty");
    if (draft.revision >= 1) checks.push("revision-valid");
    else failures.push("revision-valid");
    if (draft.contentHash.length === 64) checks.push("content-hash");
    else failures.push("content-hash");
    return { pass: failures.length === 0, checks, failures };
  }

  submit(id: string): TaskDraftSubmission | undefined {
    const draft = this.drafts.get(id);
    if (!draft) return undefined;
    const gate = this.runQualityGate(id);
    if (!gate?.pass) return undefined;
    this.drafts.set(id, { ...draft, status: "submitted", updatedAt: new Date().toISOString() });
    return { draftId: id, revision: draft.revision, submittedAt: new Date().toISOString() };
  }
}
