import { checkSendWindow, MetaApiError, type OutboundMessage, type SendKind } from "@marqbee/core";
import type { ContactRow, IgAccountRow, MessageRow } from "@marqbee/db";
import type { Engine } from "./context.js";

/**
 * The send worker: the only code that sends anything to Meta. It owns the
 * rate limiter, the send-time window check, the one-private-reply claim,
 * retries and the dead-letter table.
 */
export type SendResult =
  | { status: "sent" | "skipped" | "failed" | "noop"; reason?: string }
  | { status: "delay"; delayMs: number; reason: string }
  | { status: "retry"; error: Error };

const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000;

export async function performSend(engine: Engine, messageId: string, opts: { finalAttempt?: boolean } = {}): Promise<SendResult> {
  const { db } = engine;
  const [existing] = await db<MessageRow[]>`select * from messages where id = ${messageId}`;
  if (!existing || existing.direction !== "out") return { status: "noop", reason: "missing" };
  if (existing.status === "sent" || existing.status === "skipped" || existing.status === "failed") return { status: "noop", reason: `already_${existing.status}` };

  // Claim with a lease: a concurrent duplicate delivery of this job gets nothing.
  const [msg] = await db<MessageRow[]>`
    update messages set status = 'sending', locked_until = now() + interval '2 minutes'
    where id = ${messageId} and (status = 'queued' or (status = 'sending' and (locked_until is null or locked_until < now())))
    returning *`;
  if (!msg) return { status: "noop", reason: "locked" };
  const release = () => db`update messages set status = 'queued', locked_until = null where id = ${msg.id}`;

  const [account] = await db<IgAccountRow[]>`select * from ig_accounts where id = ${msg.ig_account_id}`;
  const [contact] = await db<ContactRow[]>`select * from contacts where id = ${msg.contact_id}`;
  if (!account || !contact) return finish(engine, msg, "failed", "missing_account_or_contact");
  if (account.status !== "active") return finish(engine, msg, "failed", "account_needs_reconnect");

  const payload = msg.payload as { message?: OutboundMessage; commentId?: string; humanAgent?: boolean };
  const isBot = msg.sent_by === "bot";
  if (isBot && contact.bot_paused && msg.kind !== "public_reply") return finish(engine, msg, "skipped", "bot_paused");

  // Window check happens now, at send time — never when the send was scheduled.
  let commentAt: Date | null = null;
  if (msg.kind === "private_reply" || msg.kind === "public_reply") {
    const [cr] = await db<{ commented_at: Date; private_reply_sent_at: Date | null; private_reply_message_id: string | null; public_reply_id: string | null }[]>`
      select commented_at, private_reply_sent_at, private_reply_message_id, public_reply_id from comment_replies where comment_id = ${payload.commentId ?? ""}`;
    if (!cr) return finish(engine, msg, "failed", "comment_not_claimed");
    commentAt = cr.commented_at;
    if (msg.kind === "private_reply" && (cr.private_reply_sent_at || (cr.private_reply_message_id && cr.private_reply_message_id !== msg.id))) {
      return finish(engine, msg, "skipped", "private_reply_already_sent");
    }
    if (msg.kind === "public_reply" && cr.public_reply_id) return finish(engine, msg, "skipped", "public_reply_already_sent");
  }
  if (msg.kind !== "public_reply") {
    const kind: SendKind = msg.kind === "private_reply" ? "private_reply" : payload.humanAgent ? "human_agent" : "standard";
    const w = checkSendWindow(kind, { lastInboundAt: contact.last_inbound_at, commentAt });
    if (!w.ok) return finish(engine, msg, "skipped", w.reason!, { deadLetter: true });
  }

  // Rate limit: per account, with a separate fast lane for Live comments.
  const lane = (await isLive(engine, msg)) ? "live" : "default";
  const rl = await engine.limiter.take(account.id, lane);
  if (!rl.allowed) {
    await release();
    return { status: "delay", delayMs: rl.retryAfterMs + jitter(), reason: "rate_limited" };
  }

  if (msg.kind === "private_reply") {
    const claim = await db`
      update comment_replies set private_reply_message_id = ${msg.id}
      where comment_id = ${payload.commentId!} and private_reply_sent_at is null
        and (private_reply_message_id is null or private_reply_message_id = ${msg.id})
      returning comment_id`;
    if (claim.length === 0) return finish(engine, msg, "skipped", "private_reply_already_sent");
  }

  await db`update messages set attempts = attempts + 1 where id = ${msg.id}`;
  let token: string;
  try {
    token = await engine.vault.decrypt(account.access_token_enc);
  } catch (err) {
    // Wrong/rotated TOKEN_ENCRYPTION_KEY or a wiped token: retrying can't help.
    engine.log.error({ accountId: account.id, err: (err as Error).message }, "cannot decrypt access token; account needs reconnect");
    await db`update ig_accounts set status = 'needs_reconnect', updated_at = now() where id = ${account.id}`;
    return finish(engine, msg, "failed", "token_unreadable", { deadLetter: true });
  }

  let metaId: string;
  try {
    if (msg.kind === "private_reply") {
      metaId = (await engine.meta.sendPrivateReply(token, account.ig_user_id, payload.commentId!, payload.message!)).messageId;
    } else if (msg.kind === "public_reply") {
      metaId = (await engine.meta.replyToComment(token, payload.commentId!, msg.body)).id;
    } else {
      const m = payload.message ?? { text: msg.body };
      metaId = (await engine.meta.sendMessage(token, account.ig_user_id, contact.igsid, m, { humanAgent: payload.humanAgent })).messageId;
    }
  } catch (err) {
    if (!(err instanceof MetaApiError)) {
      engine.log.warn({ messageId: msg.id, err: (err as Error).message }, "send failed before reaching Meta; will retry");
      await release();
      return { status: "retry", error: err as Error };
    }
    const code = String(err.code ?? err.httpStatus);
    engine.log.warn({ messageId: msg.id, code, class: err.errorClass, accountId: account.id }, "meta send failed");
    switch (err.errorClass) {
      case "rate_limited":
        await engine.limiter.pause(account.id, RATE_LIMIT_PAUSE_MS);
        await db`update messages set status = 'queued', locked_until = null, error_code = ${code} where id = ${msg.id}`;
        return { status: "delay", delayMs: RATE_LIMIT_PAUSE_MS + jitter(), reason: "meta_rate_limited" };
      case "auth":
        await db`update ig_accounts set status = 'needs_reconnect', updated_at = now() where id = ${account.id}`;
        return finish(engine, msg, "failed", "auth_error", { code, error: err.message, deadLetter: true });
      case "permanent":
        return finish(engine, msg, "failed", "permanent_error", { code, error: err.message, deadLetter: true });
      case "transient":
        if (opts.finalAttempt) return finish(engine, msg, "failed", "retries_exhausted", { code, error: err.message, deadLetter: true });
        await db`update messages set status = 'queued', locked_until = null, error_code = ${code}, error_message = ${err.message} where id = ${msg.id}`;
        return { status: "retry", error: err };
    }
  }

  // Meta accepted the message. From here on it must never be re-queued — that would
  // double-send — so the bookkeeping is retried instead of the send.
  await withRetries(async () => {
    await db.begin(async (tx) => {
      // Instagram's echo webhook for this very DM can land first; keep our row (it has the automation context).
      await tx`delete from messages where meta_message_id = ${metaId} and id <> ${msg.id} and sent_by = 'echo'`;
      const [dup] = await tx`select 1 from messages where meta_message_id = ${metaId} and id <> ${msg.id}`;
      await tx`update messages set status = 'sent', locked_until = null, meta_message_id = ${dup ? null : metaId}, sent_at = now(),
                 error_code = null, error_message = null where id = ${msg.id}`;
      if (msg.kind === "private_reply") await tx`update comment_replies set private_reply_sent_at = now() where comment_id = ${payload.commentId!}`;
      if (msg.kind === "public_reply") {
        await tx`update comment_replies set public_reply_id = ${metaId}, public_reply_sent_at = now() where comment_id = ${payload.commentId!}`;
      }
      if (msg.kind !== "public_reply") await tx`update contacts set last_message_at = now() where id = ${contact.id}`;
    });
  }).catch(async (err) => {
    // Keep the lease far in the future so no sweeper ever re-sends it; surface loudly.
    engine.log.error({ messageId: msg.id, metaId, err: (err as Error).message }, "sent but could not record it; message left locked");
    await db`update messages set locked_until = now() + interval '100 years' where id = ${msg.id}`.catch(() => {});
  });
  return { status: "sent" };
}

async function withRetries<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 100 * 2 ** i));
    }
  }
}

async function finish(
  engine: Engine,
  msg: MessageRow,
  status: "skipped" | "failed",
  reason: string,
  opts: { code?: string; error?: string; deadLetter?: boolean } = {},
): Promise<SendResult> {
  await engine.db.begin(async (tx) => {
    await tx`update messages set status = ${status}, locked_until = null, error_code = ${opts.code ?? reason}, error_message = ${opts.error ?? reason} where id = ${msg.id}`;
    if (opts.deadLetter || status === "failed") {
      await tx`insert into dead_letters (workspace_id, message_id, reason, error_code, detail)
               values (${msg.workspace_id}, ${msg.id}, ${reason}, ${opts.code ?? null}, ${tx.json({ error: opts.error ?? null })})`;
    }
  });
  return { status, reason };
}

async function isLive(engine: Engine, msg: MessageRow): Promise<boolean> {
  if (!msg.flow_run_id) return false;
  const [r] = await engine.db<{ live: boolean }[]>`select coalesce((context->>'live')::boolean, false) as live from flow_runs where id = ${msg.flow_run_id}`;
  return r?.live ?? false;
}

const jitter = () => Math.floor(Math.random() * 500);

/** Records a human reply from the inbox and returns the message id to enqueue. */
export async function recordHumanSend(
  tx: import("@marqbee/db").Db,
  args: { workspaceId: string; contact: ContactRow; userId: string; text: string; humanAgent: boolean },
): Promise<string> {
  const [m] = await tx<{ id: string }[]>`
    insert into messages (workspace_id, ig_account_id, contact_id, direction, kind, body, payload, status, sent_by, sent_by_user_id)
    values (${args.workspaceId}, ${args.contact.ig_account_id}, ${args.contact.id}, 'out', 'dm', ${args.text},
            ${tx.json({ message: { text: args.text }, humanAgent: args.humanAgent })}, 'queued', 'human', ${args.userId})
    returning id`;
  return m!.id;
}
