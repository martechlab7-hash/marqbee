/**
 * Runs the Fastify API inside Next.js route handlers, so the whole product
 * deploys as one Vercel project. Requests are passed to Fastify in-memory
 * (inject); background work is handed to waitUntil so it can finish after
 * the response (inline driver) or is published to QStash.
 */
import { waitUntil } from "@vercel/functions";
import type { FastifyInstance } from "fastify";
import { createDb, pgRoleName } from "@marqbee/db";
import { createEngine, loadConfig, type Engine } from "@marqbee/engine";
import { buildApp } from "@marqbee/api/app";

type Backend = { app: FastifyInstance; engine: Engine };
const g = globalThis as unknown as { __marqbee?: Promise<Backend> };

function getBackend(): Promise<Backend> {
  g.__marqbee ??= (async () => {
    const config = loadConfig();
    if (pgRoleName(new URL(config.databaseUrl).username) === pgRoleName(new URL(config.databaseServiceUrl).username)) {
      throw new Error("The dashboard must use the RLS app role: set DATABASE_APP_PASSWORD (Supabase) or a separate DATABASE_URL/DATABASE_SERVICE_URL.");
    }
    const engine = createEngine(config);
    const appDb = createDb(config.databaseUrl, { max: 5 });
    const app = await buildApp({ engine, appDb });
    await app.ready();
    return { app, engine };
  })().catch((err) => {
    g.__marqbee = undefined;
    throw err;
  });
  return g.__marqbee;
}

const HOP_BY_HOP = new Set(["content-length", "transfer-encoding", "connection", "keep-alive"]);

export async function handle(req: Request): Promise<Response> {
  const { app, engine } = await getBackend();
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const res = await app.inject({
    method: req.method as "GET",
    url: url.pathname + url.search,
    headers,
    payload: hasBody ? Buffer.from(await req.arrayBuffer()) : undefined,
    remoteAddress: headers["x-forwarded-for"]?.split(",")[0]?.trim() || "127.0.0.1",
  });
  waitUntil(engine.jobs.settle());

  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k)) continue;
    if (Array.isArray(v)) v.forEach((x) => out.append(k, String(x)));
    else out.set(k, String(v));
  }
  const empty = req.method === "HEAD" || res.statusCode === 204 || res.statusCode === 304;
  return new Response(empty ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out });
}

/** For server components: GET an API path and return its JSON (null on non-2xx). */
export async function backendJson<T>(path: string): Promise<T | null> {
  const external = process.env.API_INTERNAL_URL;
  if (external) {
    const r = await fetch(external + path, { next: { revalidate: 60 } }).catch(() => null);
    return r?.ok ? ((await r.json()) as T) : null;
  }
  const { app } = await getBackend();
  const r = await app.inject({ method: "GET", url: path });
  return r.statusCode >= 200 && r.statusCode < 300 ? (r.json() as T) : null;
}
