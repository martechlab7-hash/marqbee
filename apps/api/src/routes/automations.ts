import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createAutomation, updateAutomation } from "@marqbee/engine";
import type { Deps } from "../app.js";
import { audit, requireRole } from "../auth.js";

const Button = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), title: z.string().min(1).max(20), url: z.string().url().refine((u) => /^https?:\/\//.test(u), "must be http(s)") }),
  z.object({ type: z.literal("postback"), title: z.string().min(1).max(20), payload: z.string().min(1).max(200) }),
]);

export const AutomationBody = z.object({
  igAccountId: z.string().uuid(),
  name: z.string().min(1).max(120),
  type: z.enum(["comment", "dm_keyword", "story_reply", "story_mention", "welcome"]),
  status: z.enum(["active", "paused"]).optional(),
  trigger: z.object({
    mode: z.enum(["any", "contains", "exact"]),
    keywords: z.array(z.string().max(60)).max(30).default([]),
    mediaIds: z.array(z.string().max(64)).max(50).optional(),
    ignoreReplies: z.boolean().optional(),
  }),
  config: z.object({
    publicReplies: z.array(z.string().max(300)).max(10).optional(),
    message: z.object({ text: z.string().min(1).max(640), buttons: z.array(Button).max(3).optional() }),
    followGate: z
      .object({ enabled: z.boolean(), gateText: z.string().max(640), buttonTitle: z.string().max(20), notFollowingText: z.string().max(640) })
      .optional(),
    tags: z.array(z.string().min(1).max(40)).max(10).optional(),
  }),
});

export const automationRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/automations", { preHandler: requireRole("viewer") }, async (req) =>
      req.tx(
        (tx) => tx`
        select a.id, a.name, a.type, a.status, a.trigger, a.config, a.ig_account_id, a.updated_at, i.username as account_username,
          (select count(*)::int from flow_runs r where r.automation_id = a.id) as runs,
          (select count(*)::int from messages m where m.automation_id = a.id and m.status = 'sent' and m.kind <> 'public_reply') as dms_sent,
          (select count(*)::int from link_clicks c where c.automation_id = a.id) as clicks
        from automations a join ig_accounts i on i.id = a.ig_account_id
        order by a.created_at desc`,
      ),
    );

    app.get<{ Params: { id: string } }>("/api/automations/:id", { preHandler: requireRole("viewer") }, async (req, reply) => {
      const [a] = await req.tx((tx) => tx`select * from automations where id = ${req.params.id}`);
      return a ?? reply.status(404).send({ error: "not_found" });
    });

    app.post("/api/automations", { preHandler: requireRole("admin") }, async (req) => {
      const body = AutomationBody.parse(req.body);
      return req.tx(async (tx) => {
        const [acc] = await tx`select 1 from ig_accounts where id = ${body.igAccountId}`;
        if (!acc) throw Object.assign(new Error("unknown account"), { statusCode: 400 });
        const a = await createAutomation(tx, req.auth!.workspaceId, body);
        await audit(tx, req, "create", "automation", a.id, body);
        return a;
      });
    });

    app.put<{ Params: { id: string } }>("/api/automations/:id", { preHandler: requireRole("admin") }, async (req) => {
      const body = AutomationBody.parse(req.body);
      await req.tx(async (tx) => {
        await updateAutomation(tx, req.auth!.workspaceId, req.params.id, body);
        await audit(tx, req, "update", "automation", req.params.id, body);
      });
      return { ok: true };
    });

    app.patch<{ Params: { id: string } }>("/api/automations/:id/status", { preHandler: requireRole("admin") }, async (req) => {
      const { status } = z.object({ status: z.enum(["active", "paused"]) }).parse(req.body);
      await req.tx(async (tx) => {
        await tx`update automations set status = ${status}, updated_at = now() where id = ${req.params.id}`;
        await audit(tx, req, status === "active" ? "activate" : "pause", "automation", req.params.id);
      });
      return { ok: true };
    });

    app.delete<{ Params: { id: string } }>("/api/automations/:id", { preHandler: requireRole("admin") }, async (req) => {
      await req.tx(async (tx) => {
        await tx`update flow_runs set state = 'cancelled', updated_at = now()
                 where automation_id = ${req.params.id} and state in ('running', 'waiting', 'awaiting_input')`;
        await tx`delete from automations where id = ${req.params.id}`;
        await audit(tx, req, "delete", "automation", req.params.id);
      });
      return { ok: true };
    });
  };
