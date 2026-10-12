import { normalizeWebhook, verifyMetaSignature, type NormalizedEvent } from "@marqbee/core";
import type { Engine } from "./context.js";
import { enqueueEvent } from "./queues.js";

export type IngestResult = { ok: false; status: 401 | 400 } | { ok: true; accepted: number; duplicates: number };

/**
 * Webhook ingest: verify signature, store the raw body, write one row per
 * event (unique dedupe_key), enqueue, return. No Meta calls, no matching —
 * this must return in well under a second.
 */
export async function ingestWebhook(engine: Engine, rawBody: Buffer, signature: string | undefined): Promise<IngestResult> {
  if (!verifyMetaSignature(rawBody, signature, engine.config.metaAppSecret)) return { ok: false, status: 401 };
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { ok: false, status: 400 };
  }
  await engine.db`insert into webhook_deliveries (body) values (${engine.db.json(body as never)})`;
  const events = normalizeWebhook(body);
  return storeAndEnqueue(engine, events);
}

export async function storeAndEnqueue(engine: Engine, events: NormalizedEvent[]): Promise<IngestResult & { ok: true }> {
  if (events.length === 0) return { ok: true, accepted: 0, duplicates: 0 };
  const rows = events.map((e) => ({
    ig_user_id: e.igUserId,
    type: e.kind,
    payload: e,
    dedupe_key: e.dedupeKey,
  }));
  const inserted = await engine.db<{ id: bigint }[]>`
    insert into events (ig_user_id, type, payload, dedupe_key)
    select ig_user_id, type, payload, dedupe_key
    from jsonb_to_recordset(${engine.db.json(rows as never)}::jsonb) as x(ig_user_id text, type text, payload jsonb, dedupe_key text)
    on conflict (dedupe_key) do nothing
    returning id`;
  // If Redis is briefly down the rows are still in Postgres; the sweeper re-enqueues them.
  await Promise.all(inserted.map((r) => enqueueEvent(engine.queues, r.id))).catch((err) =>
    engine.log.warn({ err }, "enqueue failed; sweeper will pick events up"),
  );
  return { ok: true, accepted: inserted.length, duplicates: events.length - inserted.length };
}
