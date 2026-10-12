import type { FastifyPluginAsync } from "fastify";
import type { IgAccountRow } from "@marqbee/db";
import type { Deps } from "../app.js";
import { audit, requireRole } from "../auth.js";

export const accountRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const { engine } = deps;

    app.get("/api/accounts", { preHandler: requireRole("viewer") }, async (req) => {
      const accounts = await req.tx(
        (tx) => tx`
        select id, ig_user_id, username, name, profile_picture_url, account_type, status, token_expires_at, created_at
        from ig_accounts where status <> 'disconnected' order by created_at`,
      );
      // Queue depth + ETA per account, so a viral post shows "N DMs queued, ~X min".
      const out = [];
      for (const a of accounts) {
        const [q] = await engine.db<{ n: number }[]>`
          select count(*)::int n from messages where ig_account_id = ${a.id} and direction = 'out' and status in ('queued', 'sending')`;
        out.push({ ...a, queued: q!.n, queueEtaMs: q!.n ? engine.limiter.etaMs(q!.n) : 0 });
      }
      return out;
    });

    app.get<{ Params: { id: string } }>("/api/accounts/:id/media", { preHandler: requireRole("viewer") }, async (req, reply) => {
      const [a] = await req.tx((tx) => tx<IgAccountRow[]>`select * from ig_accounts where id = ${req.params.id}`);
      if (!a) return reply.status(404).send({ error: "not_found" });
      try {
        return await engine.meta.listMedia(await engine.vault.decrypt(a.access_token_enc));
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, "listMedia failed");
        return reply.status(502).send({ error: "Could not load posts from Instagram" });
      }
    });

    app.delete<{ Params: { id: string } }>("/api/accounts/:id", { preHandler: requireRole("admin") }, async (req) => {
      await req.tx(async (tx) => {
        await tx`update ig_accounts set status = 'disconnected', access_token_enc = '', updated_at = now() where id = ${req.params.id}`;
        await tx`update automations set status = 'paused' where ig_account_id = ${req.params.id}`;
        await audit(tx, req, "disconnect", "ig_account", req.params.id);
      });
      return { ok: true };
    });
  };
