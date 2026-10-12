import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const QUEUE = {
  events: "events",
  sends: "sends",
  resume: "flow-resume",
  maintenance: "maintenance",
} as const;

export interface Queues {
  events: Queue<{ eventId: string }>;
  sends: Queue<{ messageId: string }>;
  resume: Queue<{ runId: string }>;
  maintenance: Queue<Record<string, never>>;
}

export function createQueues(connection: Redis, prefix: string): Queues {
  const common = { connection, prefix };
  return {
    events: new Queue(QUEUE.events, {
      ...common,
      defaultJobOptions: { attempts: 8, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 1000, removeOnFail: 5000 },
    }),
    sends: new Queue(QUEUE.sends, {
      ...common,
      defaultJobOptions: { attempts: 6, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 5000, removeOnFail: 5000 },
    }),
    resume: new Queue(QUEUE.resume, { ...common, defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 1000 } }),
    maintenance: new Queue(QUEUE.maintenance, { ...common, defaultJobOptions: { removeOnComplete: 100, removeOnFail: 100 } }),
  };
}

/** jobIds make enqueueing idempotent: the same message/event is never queued twice. */
export const enqueueEvent = (q: Queues, eventId: string | bigint) => q.events.add("event", { eventId: String(eventId) }, { jobId: `evt-${eventId}` });
export const enqueueSend = (q: Queues, messageId: string, opts: { priority?: number } = {}) =>
  q.sends.add("send", { messageId }, { jobId: messageId, priority: opts.priority });
