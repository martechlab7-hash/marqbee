import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { Receiver } from "@upstash/qstash";
import { expireRuns, QStashJobs, reconcileComments, refreshTokens, runTask, sweepOutbox, type Task } from "@marqbee/engine";
import type { Deps } from "../app.js";

/**
 * Serverless entry points (Vercel):
 *  - POST /internal/jobs/:kind — QStash delivers queued jobs here (signed).
 *  - GET|POST /internal/cron/:job — Vercel Cron (Bearer CRON_SECRET) or QStash schedules (signed).
 */
export const internalRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const { engine } = deps;
    const { config } = engine;
    const receiver =
      config.qstash?.currentSigningKey && config.qstash.nextSigningKey
        ? new Receiver({ currentSigningKey: config.qstash.currentSigningKey, nextSigningKey: config.qstash.nextSigningKey })
        : null;

    async function fromQStash(req: FastifyRequest): Promise<boolean> {
      const signature = req.headers["upstash-signature"];
      if (!receiver || typeof signature !== "string") return false;
      try {
        return await receiver.verify({ signature, body: (req.rawBody ?? Buffer.alloc(0)).toString("utf8") });
      } catch {
        return false;
      }
    }

    function fromVercelCron(req: FastifyRequest): boolean {
      const given = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${config.cronSecret ?? ""}`);
      return !!config.cronSecret && given.length === expected.length && timingSafeEqual(given, expected);
    }

    app.post<{ Params: { kind: string }; Body: Record<string, string> }>("/internal/jobs/:kind", async (req, reply) => {
      if (!(await fromQStash(req))) return reply.status(401).send({ error: "bad_signature" });
      const retried = Number(req.headers["upstash-retried"] ?? 0);
      const b = req.body ?? {};
      const task: Task | null =
        req.params.kind === "event" && b.eventId
          ? { kind: "event", eventId: b.eventId }
          : req.params.kind === "send" && b.messageId
            ? { kind: "send", messageId: b.messageId, finalAttempt: retried >= QStashJobs.RETRIES }
            : req.params.kind === "resume" && b.runId
              ? { kind: "resume", runId: b.runId }
              : null;
      if (!task) return reply.status(400).send({ error: "bad_job" });

      const r = await runTask(engine, task);
      if (task.kind === "send" && r.status === "delay") {
        // Rate-limited: schedule a fresh delivery for when a token is free; this one is done.
        await engine.jobs.send(task.messageId, { delayMs: (r as { delayMs: number }).delayMs, attempt: Date.now() });
      } else if (task.kind === "send" && r.status === "retry") {
        // Non-2xx makes QStash retry with backoff.
        return reply.status(503).send({ error: "retry", detail: (r as { error: Error }).error.message });
      }
      await engine.jobs.settle();
      return { ok: true, status: r.status };
    });

    const CRON: Record<string, () => Promise<unknown>> = {
      sweep: () => sweepOutbox(engine),
      reconcile: () => reconcileComments(engine),
      "refresh-tokens": () => refreshTokens(engine),
      "expire-runs": () => expireRuns(engine),
    };
    const cron = async (req: FastifyRequest<{ Params: { job: string } }>, reply: import("fastify").FastifyReply) => {
      if (!fromVercelCron(req) && !(await fromQStash(req))) return reply.status(401).send({ error: "unauthorized" });
      const fn = CRON[req.params.job];
      if (!fn) return reply.status(404).send({ error: "unknown_job" });
      const result = await fn();
      await engine.jobs.settle(); // inline driver: finish the work the sweep started
      return { ok: true, result };
    };
    app.get("/internal/cron/:job", cron);
    app.post("/internal/cron/:job", cron);
  };
