import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { FakeMetaClient, FOLLOW_CHECK_PAYLOAD } from "@marqbee/core";
import { ingestWebhook, SharedFakeMetaClient, upsertContact } from "@marqbee/engine";
import { signMetaPayload } from "@marqbee/core";
import type { Deps } from "../app.js";
import { requireRole } from "../auth.js";
import { connectAccount } from "./meta.js";

/**
 * Local development only (registered when META_CLIENT=fake): connect a fake
 * Instagram account and simulate signed webhooks end to end, so the whole
 * pipeline can be exercised without a Meta app or App Review.
 */
export const devRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const { engine } = deps;

    app.post("/api/dev/connect-account", { preHandler: requireRole("admin") }, async (req) => {
      const { username } = z.object({ username: z.string().min(1).max(30) }).parse(req.body);
      const igUserId = `1784${Date.now().toString().slice(-11)}`;
      return connectAccount(deps, req.auth!.workspaceId, { igUserId, username, accountType: "CREATOR" }, `fake-token-${randomBytes(4).toString("hex")}`, new Date(Date.now() + 60 * 86400_000));
    });

    app.post("/api/dev/simulate", { preHandler: requireRole("admin") }, async (req, reply) => {
      const b = z
        .object({
          accountId: z.string().uuid(),
          kind: z.enum(["comment", "dm", "story_mention", "follow_tap"]),
          fromUsername: z.string().min(1).max(30),
          text: z.string().max(500).default(""),
          mediaId: z.string().optional(),
          follows: z.boolean().optional(),
        })
        .parse(req.body);
      const [acc] = await req.tx((tx) => tx<{ id: string; workspace_id: string; ig_user_id: string }[]>`select id, workspace_id, ig_user_id from ig_accounts where id = ${b.accountId}`);
      if (!acc) return reply.status(404).send({ error: "not_found" });
      const fromId = `sim_${b.fromUsername}`;
      if (b.follows !== undefined) {
        if (engine.meta instanceof SharedFakeMetaClient) await engine.meta.setFollower(fromId, b.follows);
        else if (engine.meta instanceof FakeMetaClient) b.follows ? engine.meta.followers.add(fromId) : engine.meta.followers.delete(fromId);
      }
      const id = randomBytes(6).toString("hex");
      const entry: Record<string, unknown> = { id: acc.ig_user_id, time: Math.floor(Date.now() / 1000) };
      if (b.kind === "comment") {
        entry.changes = [{ field: "comments", value: { id: `sim_c_${id}`, text: b.text, from: { id: fromId, username: b.fromUsername }, media: { id: b.mediaId ?? "fake_reel_1", media_product_type: "REELS" } } }];
      } else {
        // DM webhooks carry no username; seed it the way a profile lookup would.
        await upsertContact(engine.db, acc, fromId, { username: b.fromUsername });
        const base = { sender: { id: fromId }, recipient: { id: acc.ig_user_id }, timestamp: Date.now() };
        entry.messaging = [
          b.kind === "dm"
            ? { ...base, message: { mid: `sim_m_${id}`, text: b.text } }
            : b.kind === "story_mention"
              ? { ...base, message: { mid: `sim_m_${id}`, attachments: [{ type: "story_mention", payload: { url: "https://example.com/story.jpg" } }] } }
              : { ...base, postback: { mid: `sim_p_${id}`, payload: FOLLOW_CHECK_PAYLOAD, title: "I followed" } },
        ];
      }
      const raw = Buffer.from(JSON.stringify({ object: "instagram", entry: [entry] }));
      const r = await ingestWebhook(engine, raw, signMetaPayload(raw, engine.config.metaAppSecret));
      return r;
    });

    app.get("/api/dev/outbox", { preHandler: requireRole("viewer") }, async () =>
      engine.meta instanceof SharedFakeMetaClient ? engine.meta.recentCalls() : engine.meta instanceof FakeMetaClient ? engine.meta.calls.slice(-50).reverse() : [],
    );
  };
