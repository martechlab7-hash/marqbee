import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { audit, requireRole } from "../auth.js";

export const teamRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/team", { preHandler: requireRole("viewer") }, async (req) =>
      req.tx((tx) => tx`select u.id, u.email, u.name, m.role, m.created_at from memberships m join users u on u.id = m.user_id order by m.created_at`),
    );

    // MVP: add an existing Marqbee user by email. Email invites come with billing (week 11+).
    app.post("/api/team", { preHandler: requireRole("admin") }, async (req, reply) => {
      const b = z.object({ email: z.string().email().transform((s) => s.toLowerCase()), role: z.enum(["admin", "agent", "viewer"]) }).parse(req.body);
      const [u] = await deps.engine.db<{ id: string }[]>`select id from users where email = ${b.email}`;
      if (!u) return reply.status(404).send({ error: "Ask them to sign up first, then add them here" });
      await req.tx(async (tx) => {
        await tx`insert into memberships (workspace_id, user_id, role) values (${req.auth!.workspaceId}, ${u.id}, ${b.role})
                 on conflict (workspace_id, user_id) do update set role = excluded.role`;
        await audit(tx, req, "add_member", "membership", u.id, { role: b.role });
      });
      return { ok: true };
    });

    app.delete<{ Params: { userId: string } }>("/api/team/:userId", { preHandler: requireRole("admin") }, async (req, reply) => {
      if (req.params.userId === req.auth!.userId) return reply.status(400).send({ error: "You can't remove yourself" });
      await req.tx(async (tx) => {
        await tx`delete from memberships where user_id = ${req.params.userId} and role <> 'owner'`;
        await audit(tx, req, "remove_member", "membership", req.params.userId);
      });
      return { ok: true };
    });

    app.get("/api/audit-log", { preHandler: requireRole("admin") }, async (req) =>
      req.tx(
        (tx) => tx`select a.action, a.entity, a.entity_id, a.ts, u.email from audit_log a left join users u on u.id = a.user_id
                   order by a.ts desc limit 200`,
      ),
    );
  };
