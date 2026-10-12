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
  const [msg] = await db<MessageRow[]>`select * from messages where id = ${messageId}`;
  if (!msg || msg.direction !== "out") return { status: "noop", reason: "missing" };
  if (msg.status === "sent" || msg.status === "skipped" || msg.status === "failed") return { status: "noop", reason: `already_${msg.status}` };

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
  if (!rl.allowed) return { status: "delay", delayMs: rl.retryAfterMs + jitter(), reason: "rate_limited" };

  if (msg.kind === "private_reply") {
    const claim = await db`
      update comment_replies set private_reply_message_id = ${msg.id}
      where comment_id = ${payload.commentId!} and private_reply_sent_at is null
        and (private_reply_message_id is null or private_reply_message_id = ${msg.id})
      returning comment_id`;
    if (claim.length === 0) return finish(engine, msg, "skipped", "private_reply_already_sent");
  }

  await db`update messages set status = 'sending', attempts = attempts + 1 where id = ${msg.id}`;
  try {
    const token = await engine.vault.decrypt(account.access_token_enc);
    let metaId: string;
    if (msg.kind === "private_reply") {
      metaId = (await engine.meta.sendPrivateReply(token, account.ig_user_id, payload.commentId!, payload.message!)).messageId;
      await db`update comment_replies set private_reply_sent_at = now() where comment_id = ${payload.commentId!}`;
    } else if (msg.kind === "public_reply") {
      metaId = (await engine.meta.replyToComment(token, payload.commentId!, msg.body)).id;
      await db`update comment_replies set public_reply_id = ${metaId}, public_reply_sent_at = now() where comment_id = ${payload.commentId!}`;
    } else {
      const m = payload.message ?? { text: msg.body };
      metaId = (await engine.meta.sendMessage(token, account.ig_user_id, contact.igsid, m, { humanAgent: payload.humanAgent })).messageId;
    }
    await db`update messages set status = 'sent', meta_message_id = ${metaId}, sent_at = now(), error_code = null, error_message = null where id = ${msg.id}`;
    if (msg.kind !== "public_reply") await db`update contacts set last_message_at = now() where id = ${contact.id}`;
    return { status: "sent" };
  } catch (err) {
    if (!(err instanceof MetaApiError)) {
      await db`update messages set status = 'queued' where id = ${msg.id}`;
      return { status: "retry", error: err as Error };
    }
    const code = String(err.code ?? err.httpStatus);
    engine.log.warn({ messageId: msg.id, code, class: err.errorClass, accountId: account.id }, "meta send failed");
    switch (err.errorClass) {
      case "rate_limited":
        await engine.limiter.pause(account.id, RATE_LIMIT_PAUSE_MS);
        await db`update messages set status = 'queued', error_code = ${code} where id = ${msg.id}`;
        return { status: "delay", delayMs: RATE_LIMIT_PAUSE_MS + jitter(), reason: "meta_rate_limited" };
      case "auth":
        await db`update ig_accounts set status = 'needs_reconnect', updated_at = now() where id = ${account.id}`;
        return finish(engine, msg, "failed", "auth_error", { code, error: err.message, deadLetter: true });
      case "permanent":
        return finish(engine, msg, "failed", "permanent_error", { code, error: err.message, deadLetter: true });
      case "transient":
        if (opts.finalAttempt) return finish(engine, msg, "failed", "retries_exhausted", { code, error: err.message, deadLetter: true });
        await db`update messages set status = 'queued', error_code = ${code}, error_message = ${err.message} where id = ${msg.id}`;
        return { status: "retry", error: err };
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
    await tx`update messages set status = ${status}, error_code = ${opts.code ?? reason}, error_message = ${opts.error ?? reason} where id = ${msg.id}`;
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
