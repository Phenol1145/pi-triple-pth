import type { WorkflowIntent } from "../workflow/types.js";
import { Worker, type Job } from "bullmq";

export function createIntentWorker(redisUrl: string, onIntent: (intent: WorkflowIntent) => Promise<void>) {
  const worker = new Worker<WorkflowIntent>(
    "intents",
    async (job: Job<WorkflowIntent>) => {
      await onIntent(job.data);
    },
    {
      connection: { url: redisUrl },
      concurrency: 1,
      lockDuration: 30_000,
    },
  );
  return worker;
}
