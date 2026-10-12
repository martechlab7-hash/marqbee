import type { Engine } from "./context.js";
import { resumeWaitingRun } from "./maintenance.js";
import { processEvent } from "./process-event.js";
import { enqueueEvent, enqueueSend, type Queues } from "./queues.js";
import { performSend, type SendResult } from "./send.js";

/**
 * How background work is dispatched. Business code only talks to this
 * interface, so the same engine runs on:
 *  - bullmq: long-running workers (local dev, Render, AWS)
 *  - qstash: Vercel — Upstash QStash calls back /internal/jobs/:kind over HTTP
 *  - inline: Vercel without QStash — work runs after the response via waitUntil;
 *            delayed work is picked up by the cron sweeper
 */
export interface Jobs {
  readonly kind: "bullmq" | "qstash" | "inline";
  event(eventId: string | bigint): Promise<void>;
  send(messageId: string, opts?: { delayMs?: number; priority?: number; attempt?: number }): Promise<void>;
  resume(runId: string, at: Date): Promise<void>;
  /** Resolves when work started by this process has finished (inline driver); hand it to waitUntil. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export type Task = { kind: "event"; eventId: string } | { kind: "send"; messageId: string; finalAttempt?: boolean } | { kind: "resume"; runId: string };

export async function runTask(engine: Engine, task: Task): Promise<SendResult | { status: string }> {
  switch (task.kind) {
    case "event":
      return processEvent(engine, task.eventId);
    case "send":
      return performSend(engine, task.messageId, { finalAttempt: task.finalAttempt });
    case "resume":
      return { status: await resumeWaitingRun(engine, task.runId) };
  }
}

export class BullJobs implements Jobs {
  readonly kind = "bullmq";
  constructor(readonly queues: Queues) {}
  async event(id: string | bigint) {
    await enqueueEvent(this.queues, id);
  }
  async send(id: string, opts: { delayMs?: number; priority?: number } = {}) {
    await enqueueSend(this.queues, id, opts);
  }
  async resume(runId: string, at: Date) {
    await this.queues.resume.add("resume", { runId }, { jobId: `resume-${runId}-${at.getTime()}`, delay: Math.max(0, at.getTime() - Date.now()) });
  }
  async settle() {}
  async close() {
    await Promise.all(Object.values(this.queues).map((q) => q.close()));
  }
}

export class QStashJobs implements Jobs {
  readonly kind = "qstash";
  static readonly RETRIES = 5;
  constructor(
    private readonly opts: { token: string; baseUrl: string; qstashUrl?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async publish(path: string, body: unknown, dedupeId: string, delayMs = 0) {
    const dest = `${this.opts.baseUrl}${path}`;
    const res = await this.fetchImpl(`${this.opts.qstashUrl ?? "https://qstash.upstash.io"}/v2/publish/${dest}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        "Content-Type": "application/json",
        "Upstash-Deduplication-Id": dedupeId,
        "Upstash-Retries": String(QStashJobs.RETRIES),
        ...(delayMs > 0 ? { "Upstash-Delay": `${Math.ceil(delayMs / 1000)}s` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`QStash publish failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  event(id: string | bigint) {
    return this.publish("/internal/jobs/event", { eventId: String(id) }, `evt-${id}`);
  }
  send(id: string, opts: { delayMs?: number; attempt?: number } = {}) {
    // Re-publishes after a rate-limit delay need a fresh dedupe id.
    return this.publish("/internal/jobs/send", { messageId: id }, opts.attempt ? `send-${id}-${opts.attempt}` : `send-${id}`, opts.delayMs);
  }
  resume(runId: string, at: Date) {
    return this.publish("/internal/jobs/resume", { runId }, `resume-${runId}-${at.getTime()}`, at.getTime() - Date.now());
  }
  async settle() {}
  async close() {}
}

export class InlineJobs implements Jobs {
  readonly kind = "inline";
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly run: (task: Task) => Promise<unknown>,
    private readonly onError: (err: unknown, task: Task) => void = () => {},
  ) {}

  private track(task: Task) {
    const p = this.run(task)
      .catch((err) => this.onError(err, task)) // left in Postgres as queued/unprocessed; the cron sweeper retries
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
  async event(id: string | bigint) {
    this.track({ kind: "event", eventId: String(id) });
  }
  async send(id: string, opts: { delayMs?: number } = {}) {
    // Delayed (rate-limited) sends stay queued in Postgres for the sweeper.
    if (!opts.delayMs) this.track({ kind: "send", messageId: id });
  }
  async resume(runId: string, at: Date) {
    if (at.getTime() <= Date.now()) this.track({ kind: "resume", runId });
  }
  async settle() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
  async close() {
    await this.settle();
  }
}
