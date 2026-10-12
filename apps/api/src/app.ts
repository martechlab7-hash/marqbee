import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import type { Sql } from "@marqbee/db";
import { ValidationError, type Engine } from "@marqbee/engine";
import { ZodError } from "zod";
import { registerAuth } from "./auth.js";
import { metaRoutes } from "./routes/meta.js";
import { publicRoutes } from "./routes/public.js";
import { authRoutes } from "./routes/auth.js";
import { accountRoutes } from "./routes/accounts.js";
import { automationRoutes } from "./routes/automations.js";
import { contactRoutes } from "./routes/contacts.js";
import { bioRoutes } from "./routes/bio.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { teamRoutes } from "./routes/team.js";
import { devRoutes } from "./routes/dev.js";
import { internalRoutes } from "./routes/internal.js";

export interface Deps {
  engine: Engine;
  /** RLS-enforced connection (marqbee_app role). */
  appDb: Sql;
}

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const { config } = deps.engine;
  const app = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL || "info", redact: ["req.headers.cookie", "req.headers.authorization"] },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  // Keep the exact bytes: Meta's signature is computed over the raw body.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch {
      const err = new Error("invalid JSON") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(formbody);
  await app.register(cors, { origin: [config.publicWebUrl], credentials: true });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "invalid_request", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    if (err instanceof ValidationError) return reply.status(422).send({ error: "validation_failed", issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "unhandled error");
    return reply.status(status).send({ error: status >= 500 ? "internal_error" : (err as Error).message });
  });

  app.get("/health", async () => {
    await deps.engine.db`select 1`;
    await deps.engine.redis.ping();
    return { ok: true, jobs: deps.engine.jobs.kind, meta: config.metaClient };
  });

  registerAuth(app, deps);
  await app.register(metaRoutes(deps));
  await app.register(publicRoutes(deps));
  await app.register(authRoutes(deps));
  await app.register(accountRoutes(deps));
  await app.register(automationRoutes(deps));
  await app.register(contactRoutes(deps));
  await app.register(bioRoutes(deps));
  await app.register(analyticsRoutes(deps));
  await app.register(teamRoutes(deps));
  await app.register(internalRoutes(deps));
  if (config.metaClient === "fake") await app.register(devRoutes(deps));
  return app;
}
