import { randomBytes } from "node:crypto";
import { runFlow, type FlowGraph, type FlowPort, type OutboundMessage, type RunOutcome } from "@marqbee/core";
import type { ContactRow, Db, FlowRunRow, IgAccountRow } from "@marqbee/db";
import type { Engine } from "./context.js";
import { addTags, removeTags } from "./contacts.js";

/**
 * Flow-run orchestration. Runs execute inside the caller's DB transaction and
 * only *record* sends (messages rows, status=queued). The caller enqueues the
 * returned message ids after commit — a transactional outbox, so a crash can
 * never produce a send without a row or a row without (eventually) a send.
 */
export interface RunEffects {
  messageIds: string[];
  resume?: { runId: string; at: Date };
}

interface StartArgs {
  account: IgAccountRow;
  contact: ContactRow;
  automationId: string;
  flowVersionId: string;
  graph: FlowGraph;
  context: FlowRunRow["context"];
}

export async function startRun(engine: Engine, tx: Db, args: StartArgs): Promise<RunEffects> {
  const [run] = await tx<FlowRunRow[]>`
    insert into flow_runs (workspace_id, contact_id, automation_id, flow_version_id, state, current_node, context)
    values (${args.account.workspace_id}, ${args.contact.id}, ${args.automationId}, ${args.flowVersionId}, 'running',
            ${args.graph.start}, ${tx.json({ ...args.context, step: 0 } as never)})
    returning *`;
  return advance(engine, tx, args.account, args.contact, run!, args.graph, args.graph.start);
}

export async function resumeRun(
  engine: Engine,
  tx: Db,
  account: IgAccountRow,
  contact: ContactRow,
  run: FlowRunRow,
  fromNode: string,
): Promise<RunEffects> {
  const [v] = await tx<{ graph: FlowGraph }[]>`select graph from flow_versions where id = ${run.flow_version_id}`;
  return advance(engine, tx, account, contact, run, v!.graph, fromNode);
}

async function advance(
  engine: Engine,
  tx: Db,
  account: IgAccountRow,
  contact: ContactRow,
  run: FlowRunRow,
  graph: FlowGraph,
  fromNode: string,
): Promise<RunEffects> {
  const effects: RunEffects = { messageIds: [] };
  const ctx = { ...run.context };
  ctx.step = (ctx.step ?? 0) + 1;

  const record = async (kind: "dm" | "private_reply" | "public_reply", nodeId: string, body: string, payload: Record<string, unknown>) => {
    const [m] = await tx<{ id: string }[]>`
      insert into messages (workspace_id, ig_account_id, contact_id, direction, kind, body, payload, status, sent_by,
                            automation_id, flow_run_id, idempotency_key)
      values (${account.workspace_id}, ${account.id}, ${contact.id}, 'out', ${kind}, ${body}, ${tx.json(payload as never)},
              'queued', 'bot', ${run.automation_id}, ${run.id}, ${`${run.id}:${ctx.step}:${nodeId}`})
      on conflict (idempotency_key) do nothing
      returning id`;
    if (m) effects.messageIds.push(m.id);
  };

  const port: FlowPort = {
    async enqueueSend({ nodeId, message }) {
      const msg = await trackLinks(tx, account.workspace_id, contact.id, run.automation_id, message, engine.config.publicWebUrl);
      // The first message of a comment-triggered run is the one allowed private reply.
      if (ctx.commentId && !ctx.privateReplyUsed) {
        ctx.privateReplyUsed = true;
        await record("private_reply", nodeId, msg.text, { message: msg, commentId: ctx.commentId });
      } else {
        await record("dm", nodeId, msg.text, { message: msg });
      }
    },
    async enqueuePublicReply({ nodeId, text }) {
      if (ctx.commentId) await record("public_reply", nodeId, text, { commentId: ctx.commentId });
    },
    addTag: (tag) => addTags(tx, contact.id, [tag]),
    removeTag: (tag) => removeTags(tx, contact.id, [tag]),
    async hasTag(tag) {
      const [r] = await tx<{ ok: boolean }[]>`select ${tag} = any(tags) as ok from contacts where id = ${contact.id}`;
      return r?.ok ?? false;
    },
    async isFollower() {
      try {
        const token = await engine.vault.decrypt(account.access_token_enc);
        const p = await engine.meta.getProfile(token, contact.igsid);
        await tx`update contacts set is_follower = ${p.isFollower ?? null}, username = coalesce(${p.username ?? null}, username) where id = ${contact.id}`;
        return p.isFollower === true;
      } catch (err) {
        engine.log.warn({ err, contactId: contact.id }, "follower check failed; treating as not following");
        return false;
      }
    },
  };

  let outcome: RunOutcome;
  try {
    outcome = await runFlow(graph, fromNode, { runId: run.id, vars: { username: contact.username ?? "", name: contact.name ?? contact.username ?? "" } }, port);
  } catch (err) {
    outcome = { status: "failed", error: (err as Error).message };
  }

  const state = outcome.status === "completed" ? "completed" : outcome.status === "failed" ? "failed" : outcome.status;
  const node = "node" in outcome ? outcome.node : null;
  const resumeAt = outcome.status === "waiting" ? outcome.resumeAt : null;
  await tx`
    update flow_runs set state = ${state}, current_node = ${node}, resume_at = ${resumeAt},
      context = ${tx.json(ctx as never)}, error = ${outcome.status === "failed" ? outcome.error : null}, updated_at = now()
    where id = ${run.id}`;
  if (resumeAt) effects.resume = { runId: run.id, at: resumeAt };
  return effects;
}

/** Rewrites URL buttons to /r/<code> so clicks attribute back to this contact. */
async function trackLinks(
  tx: Db,
  workspaceId: string,
  contactId: string,
  automationId: string | null,
  msg: OutboundMessage,
  baseUrl: string,
): Promise<OutboundMessage> {
  if (!msg.buttons?.some((b) => b.type === "url")) return msg;
  const buttons = await Promise.all(
    msg.buttons.map(async (b) => {
      if (b.type !== "url") return b;
      const code = randomBytes(6).toString("base64url");
      await tx`insert into tracked_links (code, workspace_id, url, contact_id, automation_id)
               values (${code}, ${workspaceId}, ${b.url}, ${contactId}, ${automationId})`;
      return { ...b, url: `${baseUrl}/r/${code}` };
    }),
  );
  return { ...msg, buttons };
}

export async function enqueueEffects(engine: Engine, effects: RunEffects): Promise<void> {
  for (const id of effects.messageIds) await engine.jobs.send(id);
  if (effects.resume) await engine.jobs.resume(effects.resume.runId, effects.resume.at);
}
