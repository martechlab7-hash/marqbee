import { DelayedError, Worker, type Job } from "bullmq";
import type { Engine } from "./context.js";
import { expireRuns, reconcileComments, refreshTokens, resumeWaitingRun, sweepOutbox } from "./maintenance.js";
import { processEvent } from "./process-event.js";
import { QUEUE } from "./queues.js";
import { performSend } from "./send.js";

export interface WorkerOptions {
  eventConcurrency?: number;
  sendConcurrency?: number;
  /** Register repeatable maintenance jobs (token refresh, reconciliation, sweeper). */
  schedule?: boolean;
}

export async function startWorkers(engine: Engine, opts: WorkerOptions = {}): Promise<{ close(): Promise<void> }> {
  const connection = engine.redis.duplicate({ maxRetriesPerRequest: null });
  const prefix = engine.queues.events.opts.prefix;
  const common = { connection, prefix };

  const events = new Worker<{ eventId: string }>(
    QUEUE.events,
    async (job) => {
      const r = await processEvent(engine, job.data.eventId);
      return r.status;
    },
    { ...common, concurrency: opts.eventConcurrency ?? 20 },
  );

  const sends = new Worker<{ messageId: string }>(
    QUEUE.sends,
    async (job: Job<{ messageId: string }>, token?: string) => {
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const r = await performSend(engine, job.data.messageId, { finalAttempt });
      if (r.status === "delay") {
        // Rate-limited: park the job until a token is available. Not a failure, no attempt consumed.
        await job.moveToDelayed(Date.now() + r.delayMs, token);
        throw new DelayedError();
      }
      if (r.status === "retry") throw r.error;
      return r;
    },
    { ...common, concurrency: opts.sendConcurrency ?? 10 },
  );

  const resume = new Worker<{ runId: string }>(QUEUE.resume, async (job) => resumeWaitingRun(engine, job.data.runId), { ...common, concurrency: 10 });

  const maintenance = new Worker(
    QUEUE.maintenance,
    async (job) => {
      switch (job.name) {
        case "sweep":
          return sweepOutbox(engine);
        case "reconcile":
          return reconcileComments(engine);
        case "refresh-tokens":
          return refreshTokens(engine);
        case "expire-runs":
          return expireRuns(engine);
      }
    },
    { ...common, concurrency: 1 },
  );

  for (const w of [events, sends, resume, maintenance]) {
    w.on("failed", (job, err) => engine.log.error({ queue: w.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, "job failed"));
    w.on("error", (err) => engine.log.error({ queue: w.name, err: err.message }, "worker error"));
  }

  if (opts.schedule) {
    const q = engine.queues.maintenance;
    await q.upsertJobScheduler("sweep", { every: 60_000 }, { name: "sweep" });
    await q.upsertJobScheduler("reconcile", { every: 10 * 60_000 }, { name: "reconcile" });
    await q.upsertJobScheduler("refresh-tokens", { every: 6 * 3600_000 }, { name: "refresh-tokens" });
    await q.upsertJobScheduler("expire-runs", { every: 3600_000 }, { name: "expire-runs" });
  }

  return {
    async close() {
      await Promise.all([events.close(), sends.close(), resume.close(), maintenance.close()]);
      connection.disconnect();
    },
  };
}
