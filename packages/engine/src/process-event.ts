import { matchKeyword, routeReply, type FlowGraph, type NormalizedEvent, type TriggerKind } from "@marqbee/core";
import type { AutomationRow, ContactRow, Db, FlowRunRow, IgAccountRow } from "@marqbee/db";
import type { Engine } from "./context.js";
import { upsertContact } from "./contacts.js";
import { enqueueEffects, resumeRun, startRun, type RunEffects } from "./runs.js";

type Automation = AutomationRow & { flow_version_id: string; graph: FlowGraph };

/**
 * Event processor (flow engine entry point). Everything for one event happens
 * in one transaction: contact upsert, inbox write, comment claim, run start,
 * outbound message rows, and marking the event processed. Sends are enqueued
 * only after commit.
 */
export async function processEvent(engine: Engine, eventId: string): Promise<{ status: string }> {
  const effects: RunEffects[] = [];
  const status = await engine.db.begin(async (tx) => {
    const [ev] = await tx<{ id: string; payload: NormalizedEvent; processed_at: Date | null }[]>`
      select id, payload, processed_at from events where id = ${eventId} for update`;
    if (!ev) return "missing";
    if (ev.processed_at) return "already_processed";
    const e = reviveDates(ev.payload);

    const [account] = await tx<IgAccountRow[]>`select * from ig_accounts where ig_user_id = ${e.igUserId}`;
    let result = "no_account";
    if (account && account.status !== "disconnected") {
      result = await handle(engine, tx, account, e, effects);
    }
    await tx`update events set processed_at = now(), workspace_id = ${account?.workspace_id ?? null},
             ig_account_id = ${account?.id ?? null}, error = ${result.startsWith("error") ? result : null} where id = ${eventId}`;
    return result;
  });
  for (const fx of effects) await enqueueEffects(engine, fx);
  return { status: status as string };
}

function reviveDates(e: NormalizedEvent): NormalizedEvent {
  return { ...e, occurredAt: new Date(e.occurredAt as unknown as string) };
}

async function handle(engine: Engine, tx: Db, account: IgAccountRow, e: NormalizedEvent, effects: RunEffects[]): Promise<string> {
  switch (e.kind) {
    case "comment":
      return handleComment(engine, tx, account, e, effects);
    case "message":
      return handleMessage(engine, tx, account, e, effects);
    case "postback":
      return handlePostback(engine, tx, account, e, effects);
  }
}

async function loadAutomations(tx: Db, accountId: string, type: TriggerKind): Promise<Automation[]> {
  return tx<Automation[]>`
    select a.*, f.current_version_id as flow_version_id, v.graph
    from automations a
    join flows f on f.id = a.flow_id
    join flow_versions v on v.id = f.current_version_id
    where a.ig_account_id = ${accountId} and a.type = ${type} and a.status = 'active'
    order by a.priority desc, a.created_at asc`;
}

async function handleComment(engine: Engine, tx: Db, account: IgAccountRow, e: Extract<NormalizedEvent, { kind: "comment" }>, effects: RunEffects[]) {
  // Our own public replies come back as comment webhooks; never react to them.
  if (e.fromId === account.ig_user_id) return "own_comment";

  const automations = await loadAutomations(tx, account.id, "comment");
  let matched: { a: Automation; keyword: string } | undefined;
  for (const a of automations) {
    if (a.trigger.mediaIds?.length && (!e.mediaId || !a.trigger.mediaIds.includes(e.mediaId))) continue;
    if (e.parentId && a.trigger.ignoreReplies !== false) continue;
    const keyword = matchKeyword(e.text, a.trigger);
    if (keyword) {
      matched = { a, keyword };
      break;
    }
  }
  if (!matched) return "no_match";

  const contact = await upsertContact(tx, account, e.fromId, {
    username: e.fromUsername,
    source: { type: "comment", automationId: matched.a.id, mediaId: e.mediaId, keyword: matched.keyword, commentId: e.commentId },
  });

  // One private reply per comment, enforced by the primary key.
  const claimed = await tx`
    insert into comment_replies (comment_id, workspace_id, ig_account_id, contact_id, automation_id, media_id, keyword, commented_at)
    values (${e.commentId}, ${account.workspace_id}, ${account.id}, ${contact.id}, ${matched.a.id}, ${e.mediaId ?? null},
            ${matched.keyword}, ${e.occurredAt})
    on conflict (comment_id) do nothing returning comment_id`;
  if (claimed.length === 0) return "duplicate_comment";

  if (contact.bot_paused) return "bot_paused";
  effects.push(
    await startRun(engine, tx, {
      account,
      contact,
      automationId: matched.a.id,
      flowVersionId: matched.a.flow_version_id,
      graph: matched.a.graph,
      context: { commentId: e.commentId, commentAt: e.occurredAt.toISOString(), mediaId: e.mediaId, keyword: matched.keyword, live: e.isLive },
    }),
  );
  return "run_started";
}

async function handleMessage(engine: Engine, tx: Db, account: IgAccountRow, e: Extract<NormalizedEvent, { kind: "message" }>, effects: RunEffects[]) {
  if (e.isEcho) {
    // Sent by the business (our own sends, or a human replying from the Instagram app).
    const contact = await upsertContact(tx, account, e.recipientId);
    await tx`
      insert into messages (workspace_id, ig_account_id, contact_id, direction, body, meta_message_id, status, sent_by, sent_at)
      values (${account.workspace_id}, ${account.id}, ${contact.id}, 'out', ${e.text}, ${e.mid}, 'sent', 'echo', ${e.occurredAt})
      on conflict (meta_message_id) do nothing`;
    return "echo";
  }

  const isNew = await isNewContact(tx, account.id, e.senderId);
  const contact = await upsertContact(tx, account, e.senderId, {
    inboundAt: e.occurredAt,
    source: { type: e.storyMention ? "story_mention" : e.storyReply ? "story_reply" : "dm" },
  });
  const kind = e.storyMention ? "story_mention" : e.storyReply ? "story_reply" : "dm";
  const inserted = await tx`
    insert into messages (workspace_id, ig_account_id, contact_id, direction, kind, body, payload, meta_message_id, status)
    values (${account.workspace_id}, ${account.id}, ${contact.id}, 'in', ${kind}, ${e.text},
            ${tx.json({ storyReply: e.storyReply, storyMention: e.storyMention, quickReply: e.quickReplyPayload } as never)},
            ${e.mid}, 'received')
    on conflict (meta_message_id) do nothing returning id`;
  if (inserted.length) {
    await tx`update contacts set unread_count = unread_count + 1, last_message_at = ${e.occurredAt} where id = ${contact.id}`;
  }
  if (contact.bot_paused) return "bot_paused";

  // A parked run waiting for this person's answer takes priority over new triggers.
  if (await resumeParked(engine, tx, account, contact, { payload: e.quickReplyPayload, text: e.text }, effects)) return "run_resumed";

  const type: TriggerKind = e.storyMention ? "story_mention" : e.storyReply ? "story_reply" : "dm_keyword";
  for (const a of await loadAutomations(tx, account.id, type)) {
    if (type !== "dm_keyword" && a.trigger.mode === "any") return start(a, "*");
    const kw = matchKeyword(e.text, a.trigger);
    if (kw) return start(a, kw);
  }
  if (isNew && type === "dm_keyword") {
    const [welcome] = await loadAutomations(tx, account.id, "welcome");
    if (welcome) return start(welcome, "*");
  }
  return "no_match";

  async function start(a: Automation, keyword: string) {
    if (await hasActiveRunFor(tx, contact.id, a.id)) return "run_already_active";
    effects.push(
      await startRun(engine, tx, { account, contact, automationId: a.id, flowVersionId: a.flow_version_id, graph: a.graph, context: { keyword } }),
    );
    return "run_started";
  }
}

async function handlePostback(engine: Engine, tx: Db, account: IgAccountRow, e: Extract<NormalizedEvent, { kind: "postback" }>, effects: RunEffects[]) {
  const contact = await upsertContact(tx, account, e.senderId, { inboundAt: e.occurredAt, source: { type: "dm" } });
  await tx`
    insert into messages (workspace_id, ig_account_id, contact_id, direction, kind, body, payload, status)
    values (${account.workspace_id}, ${account.id}, ${contact.id}, 'in', 'postback', ${e.title ?? e.payload}, ${tx.json({ payload: e.payload } as never)}, 'received')`;
  await tx`update contacts set last_message_at = ${e.occurredAt} where id = ${contact.id}`;
  if (contact.bot_paused) return "bot_paused";
  return (await resumeParked(engine, tx, account, contact, { payload: e.payload }, effects)) ? "run_resumed" : "no_parked_run";
}

async function resumeParked(
  engine: Engine,
  tx: Db,
  account: IgAccountRow,
  contact: ContactRow,
  input: { payload?: string; text?: string },
  effects: RunEffects[],
): Promise<boolean> {
  const runs = await tx<(FlowRunRow & { graph: FlowGraph })[]>`
    select r.*, v.graph from flow_runs r join flow_versions v on v.id = r.flow_version_id
    where r.contact_id = ${contact.id} and r.state = 'awaiting_input'
    order by r.updated_at desc for update of r`;
  for (const run of runs) {
    const next = run.current_node ? routeReply(run.graph, run.current_node, input) : null;
    if (!next) continue;
    effects.push(await resumeRun(engine, tx, account, contact, run, next));
    return true;
  }
  return false;
}

async function isNewContact(tx: Db, accountId: string, igsid: string): Promise<boolean> {
  const [r] = await tx<{ n: number }[]>`
    select count(*)::int as n from messages m join contacts c on c.id = m.contact_id
    where c.ig_account_id = ${accountId} and c.igsid = ${igsid} and m.direction = 'in'`;
  return (r?.n ?? 0) === 0;
}

async function hasActiveRunFor(tx: Db, contactId: string, automationId: string): Promise<boolean> {
  const r = await tx`select 1 from flow_runs where contact_id = ${contactId} and automation_id = ${automationId}
                     and state in ('running', 'waiting', 'awaiting_input') and updated_at > now() - interval '24 hours' limit 1`;
  return r.length > 0;
}
