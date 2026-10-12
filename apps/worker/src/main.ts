import { createEngine, loadConfig, startWorkers } from "@marqbee/engine";

/**
 * Worker process: event processing (flow engine), the send worker, flow
 * resumes, and scheduled maintenance (outbox sweep, comment reconciliation,
 * token refresh). Scale horizontally — BullMQ and the Redis rate limiter
 * coordinate across processes.
 */
const engine = createEngine(loadConfig());
const workers = await startWorkers(engine, {
  eventConcurrency: Number(process.env.EVENT_CONCURRENCY ?? 20),
  sendConcurrency: Number(process.env.SEND_CONCURRENCY ?? 10),
  schedule: true,
});
engine.log.info({ meta: engine.config.metaClient }, "workers started");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    engine.log.info("shutting down workers");
    await workers.close();
    await engine.close();
    process.exit(0);
  });
}
