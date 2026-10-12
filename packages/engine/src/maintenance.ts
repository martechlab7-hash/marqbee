import { refreshLongLivedToken, type NormalizedEvent } from "@marqbee/core";
import type { ContactRow, FlowRunRow, IgAccountRow } from "@marqbee/db";
import type { Engine } from "./context.js";
import { storeAndEnqueue } from "./ingest.js";
import { enqueueEffects, resumeRun } from "./runs.js";

/** Resume a run parked on a `wait` node. */
export async function resumeWaitingRun(engine: Engine, runId: string): Promise<string> {
  let fx: Awaited<ReturnType<typeof resumeRun>> | undefined;
  const status = await engine.db.begin(async (tx) => {
    const [run] = await tx<FlowRunRow[]>`select * from flow_runs where id = ${runId} for update`;
    if (!run || run.state !== "waiting") return "not_waiting";
    if (run.resume_at && run.resume_at.getTime() > Date.now() + 1000) return "too_early";
    const [contact] = await tx<ContactRow[]>`select * from contacts where id = ${run.contact_id}`;
    const [account] = await tx<IgAccountRow[]>`select * from ig_accounts where id = ${contact!.ig_account_id}`;
    if (contact!.bot_paused) {
      await tx`update flow_runs set state = 'cancelled', updated_at = now() where id = ${runId}`;
      return "cancelled_bot_paused";
    }
    if (!run.current_node) {
      await tx`update flow_runs set state = 'completed', updated_at = now() where id = ${runId}`;
      return "completed";
    }
    fx = await resumeRun(engine, tx, account!, contact!, run, run.current_node);
    return "resumed";
  });
  if (fx) await enqueueEffects(engine, fx);
  return status as string;
}

/** Refresh long-lived tokens well before they expire; flag accounts we can't refresh. */
export async function refreshTokens(engine: Engine, fetchImpl: typeof fetch = fetch): Promise<{ refreshed: number; failed: number }> {
  const accounts = await engine.db<IgAccountRow[]>`
    select * from ig_accounts where status = 'active' and token_expires_at < now() + interval '10 days'`;
  let refreshed = 0;
  let failed = 0;
  for (const a of accounts) {
    try {
      const token = await engine.vault.decrypt(a.access_token_enc);
      const next = await refreshLongLivedToken(token, fetchImpl);
      const enc = await engine.vault.encrypt(next.accessToken);
      await engine.db`update ig_accounts set access_token_enc = ${enc}, token_expires_at = ${next.expiresAt}, updated_at = now() where id = ${a.id}`;
      refreshed++;
    } catch (err) {
      failed++;
      engine.log.error({ accountId: a.id, err: (err as Error).message }, "token refresh failed");
      if (a.token_expires_at && a.token_expires_at.getTime() < Date.now()) {
        await engine.db`update ig_accounts set status = 'needs_reconnect', updated_at = now() where id = ${a.id}`;
      }
    }
  }
  return { refreshed, failed };
}

/**
 * Catch comments whose webhooks never arrived (Meta outage, our outage).
 * Synthesised events share the webhook dedupe key, so anything already
 * processed is a no-op.
 */
export async function reconcileComments(engine: Engine): Promise<{ accounts: number; recovered: number }> {
  const accounts = await engine.db<IgAccountRow[]>`select * from ig_accounts where status = 'active'`;
  let recovered = 0;
  for (const a of accounts) {
    const since = Math.max(Date.now() - 2 * 3600_000, (a.last_reconciled_at?.getTime() ?? 0) - 5 * 60_000);
    const startedAt = new Date();
    try {
      const token = await engine.vault.decrypt(a.access_token_enc);
      const comments = await engine.meta.listRecentComments(token, since);
      const events: NormalizedEvent[] = comments
        .filter((c) => c.fromId)
        .map((c) => ({
          kind: "comment",
          dedupeKey: `comment:${c.id}`,
          igUserId: a.ig_user_id,
          commentId: c.id,
          text: c.text,
          fromId: c.fromId!,
          fromUsername: c.fromUsername,
          mediaId: c.mediaId,
          isLive: false,
          occurredAt: new Date(c.timestamp),
        }));
      const r = await storeAndEnqueue(engine, events);
      recovered += r.accepted;
      await engine.db`update ig_accounts set last_reconciled_at = ${startedAt} where id = ${a.id}`;
    } catch (err) {
      engine.log.warn({ accountId: a.id, err: (err as Error).message }, "reconcile failed");
    }
  }
  if (recovered) engine.log.warn({ recovered }, "reconciliation recovered missed comments");
  return { accounts: accounts.length, recovered };
}

/** Outbox sweeper: re-enqueue anything committed to Postgres that never reached the queue. */
export async function sweepOutbox(engine: Engine): Promise<{ events: number; sends: number; resumes: number }> {
  const events = await engine.db<{ id: bigint }[]>`
    select id from events where processed_at is null and received_at < now() - interval '1 minute' limit 1000`;
  for (const e of events) await engine.jobs.event(e.id);
  const sends = await engine.db<{ id: string }[]>`
    select id from messages where direction = 'out' and status in ('queued', 'sending') and created_at < now() - interval '2 minutes' limit 1000`;
  for (const m of sends) await engine.jobs.send(m.id);
  const runs = await engine.db<{ id: string }[]>`
    select id from flow_runs where state = 'waiting' and resume_at < now() - interval '1 minute' limit 1000`;
  for (const r of runs) await engine.jobs.resume(r.id, new Date());
  return { events: events.length, sends: sends.length, resumes: runs.length };
}

/** Expire parked runs whose 24h window has closed — nothing more can be sent. */
export async function expireRuns(engine: Engine): Promise<number> {
  const r = await engine.db`
    update flow_runs set state = 'cancelled', error = 'window_expired', updated_at = now()
    where state = 'awaiting_input' and updated_at < now() - interval '7 days' returning id`;
  return r.length;
}
