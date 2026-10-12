import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { checkSendWindow, windowExpiresAt } from "@marqbee/core";
import type { ContactRow } from "@marqbee/db";
import { recordHumanSend } from "@marqbee/engine";
import type { Deps } from "../app.js";
import { audit, requireRole } from "../auth.js";

const ContactPatch = z.object({
  tags: z.array(z.string().min(1).max(40)).max(50).optional(),
  email: z.string().email().max(200).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  name: z.string().max(100).nullable().optional(),
  botPaused: z.boolean().optional(),
  assignedTo: z.string().uuid().nullable().optional(),
});

const withWindow = <T extends { last_inbound_at: Date | null }>(c: T) => ({
  ...c,
  window_expires_at: windowExpiresAt(c.last_inbound_at),
  window_open: checkSendWindow("standard", { lastInboundAt: c.last_inbound_at }).ok,
  human_agent_open: checkSendWindow("human_agent", { lastInboundAt: c.last_inbound_at }).ok,
});

function csvCell(v: unknown): string {
  const s = v == null ? "" : Array.isArray(v) ? v.join(";") : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const contactRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const { engine } = deps;

    app.get<{ Querystring: { q?: string; tag?: string; cursor?: string; limit?: string } }>("/api/contacts", { preHandler: requireRole("viewer") }, async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const q = req.query.q?.trim();
      return req.tx(async (tx) => {
        const rows = await tx<ContactRow[]>`
          select c.*, i.username as account_username from contacts c join ig_accounts i on i.id = c.ig_account_id
          where true
            ${q ? tx`and (c.username ilike ${"%" + q + "%"} or c.name ilike ${"%" + q + "%"} or c.email ilike ${"%" + q + "%"})` : tx``}
            ${req.query.tag ? tx`and ${req.query.tag} = any(c.tags)` : tx``}
            ${req.query.cursor ? tx`and c.created_at < ${new Date(req.query.cursor)}` : tx``}
          order by c.created_at desc limit ${limit}`;
        const [total] = await tx<{ n: number }[]>`select count(*)::int n from contacts`;
        const tags = await tx<{ tag: string; n: number }[]>`select unnest(tags) tag, count(*)::int n from contacts group by 1 order by 2 desc limit 50`;
        return { contacts: rows.map(withWindow), total: total!.n, tags, nextCursor: rows.length === limit ? rows.at(-1)!.created_at : null };
      });
    });

    app.get("/api/contacts/export.csv", { preHandler: requireRole("admin") }, async (req, reply) => {
      const rows = await req.tx(
        (tx) => tx`select c.username, c.name, c.email, c.phone, c.tags, c.source, c.is_follower, c.last_inbound_at, c.created_at, i.username as account
                   from contacts c join ig_accounts i on i.id = c.ig_account_id order by c.created_at`,
      );
      const cols = ["username", "name", "email", "phone", "tags", "source", "is_follower", "last_inbound_at", "created_at", "account"];
      const body = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell((r as Record<string, unknown>)[c])).join(","))].join("\n");
      await req.tx((tx) => audit(tx, req, "export", "contacts", null, { count: rows.length }));
      return reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", 'attachment; filename="contacts.csv"').send(body);
    });

    app.get<{ Params: { id: string } }>("/api/contacts/:id", { preHandler: requireRole("viewer") }, async (req, reply) => {
      return req.tx(async (tx) => {
        const [c] = await tx<ContactRow[]>`select * from contacts where id = ${req.params.id}`;
        if (!c) return reply.status(404).send({ error: "not_found" });
        const runs = await tx`select r.id, r.state, r.created_at, a.name as automation from flow_runs r left join automations a on a.id = r.automation_id
                              where r.contact_id = ${c.id} order by r.created_at desc limit 20`;
        const clicks = await tx`select url, ts from link_clicks where contact_id = ${c.id} order by ts desc limit 20`;
        return { ...withWindow(c), runs, clicks };
      });
    });

    app.patch<{ Params: { id: string } }>("/api/contacts/:id", { preHandler: requireRole("agent") }, async (req, reply) => {
      const p = ContactPatch.parse(req.body);
      const [c] = await req.tx(async (tx) => {
        const r = await tx`
          update contacts set
            tags = coalesce(${p.tags ?? null}::text[], tags),
            email = ${p.email === undefined ? tx`email` : p.email},
            phone = ${p.phone === undefined ? tx`phone` : p.phone},
            name = ${p.name === undefined ? tx`name` : p.name},
            bot_paused = coalesce(${p.botPaused ?? null}::boolean, bot_paused),
            assigned_to = ${p.assignedTo === undefined ? tx`assigned_to` : p.assignedTo}
          where id = ${req.params.id} returning id`;
        if (p.botPaused) {
          await tx`update flow_runs set state = 'cancelled', updated_at = now()
                   where contact_id = ${req.params.id} and state in ('running', 'waiting', 'awaiting_input')`;
        }
        await audit(tx, req, "update", "contact", req.params.id, p);
        return r;
      });
      return c ? { ok: true } : reply.status(404).send({ error: "not_found" });
    });

    // DPDP: erase a contact and their messages on request.
    app.delete<{ Params: { id: string } }>("/api/contacts/:id", { preHandler: requireRole("admin") }, async (req) => {
      await req.tx(async (tx) => {
        await tx`delete from contacts where id = ${req.params.id}`;
        await audit(tx, req, "delete", "contact", req.params.id);
      });
      return { ok: true };
    });

    // --- Inbox ---
    app.get<{ Querystring: { filter?: "all" | "unread" | "mine" | "paused"; q?: string } }>("/api/inbox", { preHandler: requireRole("viewer") }, async (req) => {
      const f = req.query.filter ?? "all";
      const q = req.query.q?.trim();
      const rows = await req.tx(
        (tx) => tx<(ContactRow & { last_body: string; last_direction: string; account_username: string })[]>`
        select c.*, i.username as account_username, lm.body as last_body, lm.direction as last_direction
        from contacts c
        join ig_accounts i on i.id = c.ig_account_id
        join lateral (select body, direction from messages m where m.contact_id = c.id and m.kind <> 'public_reply'
                      order by created_at desc limit 1) lm on true
        where c.last_message_at is not null
          ${f === "unread" ? tx`and c.unread_count > 0` : tx``}
          ${f === "mine" ? tx`and c.assigned_to = ${req.auth!.userId}` : tx``}
          ${f === "paused" ? tx`and c.bot_paused` : tx``}
          ${q ? tx`and c.username ilike ${"%" + q + "%"}` : tx``}
        order by c.last_message_at desc limit 100`,
      );
      return rows.map(withWindow);
    });

    app.get<{ Params: { contactId: string } }>("/api/inbox/:contactId/messages", { preHandler: requireRole("viewer") }, async (req) =>
      req.tx(async (tx) => {
        const msgs = await tx`
          select m.id, m.direction, m.kind, m.body, m.payload, m.status, m.error_code, m.sent_by, m.created_at, m.sent_at,
                 u.name as sent_by_name, a.name as automation_name
          from messages m left join users u on u.id = m.sent_by_user_id left join automations a on a.id = m.automation_id
          where m.contact_id = ${req.params.contactId} order by m.created_at asc limit 500`;
        await tx`update contacts set unread_count = 0 where id = ${req.params.contactId}`;
        return msgs;
      }),
    );

    app.post<{ Params: { contactId: string } }>("/api/inbox/:contactId/messages", { preHandler: requireRole("agent") }, async (req, reply) => {
      const { text, humanAgent } = z.object({ text: z.string().min(1).max(1000), humanAgent: z.boolean().default(false) }).parse(req.body);
      const result = await req.tx(async (tx) => {
        const [c] = await tx<ContactRow[]>`select * from contacts where id = ${req.params.contactId}`;
        if (!c) return { error: 404 as const };
        // Human-agent tag (7 days) is only for genuine human replies — this endpoint is the only place it can be used.
        const w = checkSendWindow(humanAgent ? "human_agent" : "standard", { lastInboundAt: c.last_inbound_at });
        if (!w.ok) return { error: 422 as const, reason: w.reason };
        const id = await recordHumanSend(tx, { workspaceId: req.auth!.workspaceId, contact: c, userId: req.auth!.userId, text, humanAgent });
        await tx`update contacts set last_message_at = now() where id = ${c.id}`;
        return { id };
      });
      if ("error" in result) {
        return result.error === 404
          ? reply.status(404).send({ error: "not_found" })
          : reply.status(422).send({ error: "The messaging window is closed. Instagram only allows replies within 24 hours of their last message (7 days with the human-agent tag).", reason: result.reason });
      }
      await engine.jobs.send(result.id, { priority: 1 });
      return { id: result.id };
    });

    // --- Saved replies ---
    app.get("/api/saved-replies", { preHandler: requireRole("viewer") }, async (req) => req.tx((tx) => tx`select * from saved_replies order by title`));
    app.post("/api/saved-replies", { preHandler: requireRole("agent") }, async (req) => {
      const b = z.object({ title: z.string().min(1).max(60), body: z.string().min(1).max(1000) }).parse(req.body);
      const [r] = await req.tx((tx) => tx`insert into saved_replies (workspace_id, title, body) values (${req.auth!.workspaceId}, ${b.title}, ${b.body}) returning *`);
      return r;
    });
    app.delete<{ Params: { id: string } }>("/api/saved-replies/:id", { preHandler: requireRole("agent") }, async (req) => {
      await req.tx((tx) => tx`delete from saved_replies where id = ${req.params.id}`);
      return { ok: true };
    });

    app.get("/api/deliveries/failed", { preHandler: requireRole("viewer") }, async (req) =>
      req.tx(
        (tx) => tx`select d.id, d.reason, d.error_code, d.created_at, m.body, m.kind, c.username
                   from dead_letters d left join messages m on m.id = d.message_id left join contacts c on c.id = m.contact_id
                   order by d.created_at desc limit 100`,
      ),
    );
  };
