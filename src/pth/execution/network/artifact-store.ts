/**
 * execution/network/artifact-store.ts — lease-attempt-scoped ArtifactStore adapter。
 *
 * V1 使用内存实现：artifact 内容只在 gateway（每次 lease Attempt）生命周期内存在，
 * 不承诺跨 retry/pause/requeue 复用；PG 只保存 manifest/引用。`ArtifactRefV1` 从 V1
 * 起稳定，未来可替换为 durable object store（task-scoped backend）。
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  ArtifactRefV1,
  ArtifactRetentionClassV1,
} from "@away_from/pth-contracts";
import { createNetworkExecuteError } from "./errors.js";
import type { ArtifactStore, ArtifactStorePutInput, StoredArtifact } from "./types.js";

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();

  async put(input: ArtifactStorePutInput): Promise<ArtifactRefV1> {
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const artifactId = `artifact-${randomUUID()}`;
    const retentionClass: ArtifactRetentionClassV1 = input.retentionClass ?? "task";
    const ref: ArtifactRefV1 = {
      artifactId,
      storageKind: "task-artifact",
      immutableLocator: `task-artifact://${artifactId}`,
      sha256,
      byteLength: input.bytes.byteLength,
      mediaType: input.mediaType,
      retentionClass,
    };
    this.artifacts.set(artifactId, { ref, bytes: input.bytes });
    return ref;
  }

  async get(ref: ArtifactRefV1): Promise<StoredArtifact> {
    const stored = this.artifacts.get(ref.artifactId);
    if (!stored) {
      throw createNetworkExecuteError("NET_ARTIFACT_MISMATCH", `artifact ${ref.artifactId} 不存在或已过期（V1 artifact 为 lease attempt 作用域；跨 Attempt 请重新 fetch）`);
    }
    if (stored.ref.sha256 !== ref.sha256 || stored.ref.byteLength !== ref.byteLength) {
      throw createNetworkExecuteError("NET_ARTIFACT_MISMATCH", `artifact ${ref.artifactId} hash/length 不一致`);
    }
    return stored;
  }
}
