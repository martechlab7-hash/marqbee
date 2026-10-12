import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { buildAuthorizeUrl, exchangeCode, parseSignedRequest } from "@marqbee/core";
import { ingestWebhook } from "@marqbee/engine";
import type { Deps } from "../app.js";
import { requireRole } from "../auth.js";

export const WEBHOOK_FIELDS = ["comments", "live_comments", "messages", "messaging_postbacks", "messaging_seen", "message_reactions"];

export const metaRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const { engine } = deps;
    const { config } = engine;

    // Webhook verification handshake.
    app.get<{ Querystring: Record<string, string> }>("/webhooks/instagram", async (req, reply) => {
      const q = req.query;
      if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.metaVerifyToken) {
        return reply.type("text/plain").send(q["hub.challenge"] ?? "");
      }
      return reply.status(403).send("forbidden");
    });

    // Verify, store, ack. All work happens async in the workers.
    app.post("/webhooks/instagram", async (req, reply) => {
      const result = await ingestWebhook(engine, req.rawBody ?? Buffer.alloc(0), req.headers["x-hub-signature-256"] as string | undefined);
      if (!result.ok) return reply.status(result.status).send({ error: result.status === 401 ? "bad_signature" : "bad_payload" });
      return reply.send("EVENT_RECEIVED");
    });

    // --- Instagram OAuth (Instagram API with Instagram Login) ---
    const redirectUri = `${config.publicApiUrl}/oauth/instagram/callback`;

    app.get("/api/accounts/connect", { preHandler: requireRole("admin") }, async (req) => {
      const state = randomBytes(24).toString("base64url");
      await engine.db`insert into oauth_states (state, workspace_id, user_id) values (${state}, ${req.auth!.workspaceId}, ${req.auth!.userId})`;
      return { url: buildAuthorizeUrl({ appId: config.metaAppId, redirectUri, state }) };
    });

    app.get<{ Querystring: { code?: string; state?: string; error?: string; error_reason?: string } }>("/oauth/instagram/callback", async (req, reply) => {
      const back = (q: string) => reply.redirect(`${config.publicWebUrl}/app/accounts?${q}`);
      const { code, state } = req.query;
      if (req.query.error || !code || !state) return back(`error=${encodeURIComponent(req.query.error_reason ?? "cancelled")}`);
      const [s] = await engine.db<{ workspace_id: string; user_id: string }[]>`
        delete from oauth_states where state = ${state} and created_at > now() - interval '15 minutes' returning workspace_id, user_id`;
      if (!s) return back("error=expired_state");
      try {
        const tok = await exchangeCode({ appId: config.metaAppId, appSecret: config.metaAppSecret, redirectUri, code: code.replace(/#_$/, ""), graphVersion: config.metaGraphVersion });
        const me = await engine.meta.getMe(tok.accessToken);
        if (me.accountType && !["BUSINESS", "MEDIA_CREATOR", "CREATOR"].includes(me.accountType.toUpperCase())) {
          return back("error=not_professional");
        }
        await connectAccount(deps, s.workspace_id, me, tok.accessToken, tok.expiresAt);
        return back("connected=1");
      } catch (err) {
        req.log.error({ err: (err as Error).message }, "instagram oauth failed");
        return back("error=oauth_failed");
      }
    });

    // --- Callbacks Meta requires for App Review ---
    app.post<{ Body: { signed_request?: string } }>("/meta/deauthorize", async (req, reply) => {
      const data = parseSignedRequest(req.body?.signed_request ?? "", config.metaAppSecret);
      if (!data) return reply.status(400).send({ error: "bad_signed_request" });
      await engine.db`update ig_accounts set status = 'disconnected', access_token_enc = '', updated_at = now() where ig_user_id = ${data.user_id}`;
      return { ok: true };
    });

    app.post<{ Body: { signed_request?: string } }>("/meta/data-deletion", async (req, reply) => {
      const data = parseSignedRequest(req.body?.signed_request ?? "", config.metaAppSecret);
      if (!data) return reply.status(400).send({ error: "bad_signed_request" });
      const code = randomBytes(10).toString("hex");
      await engine.db.begin(async (tx) => {
        await tx`insert into data_deletion_requests (confirmation_code, ig_user_id) values (${code}, ${data.user_id})`;
        // Cascades to contacts, messages, automations, runs for that account.
        await tx`delete from ig_accounts where ig_user_id = ${data.user_id}`;
        await tx`delete from events where ig_user_id = ${data.user_id}`;
        await tx`update data_deletion_requests set status = 'completed', completed_at = now() where confirmation_code = ${code}`;
      });
      return { url: `${config.publicWebUrl}/data-deletion?code=${code}`, confirmation_code: code };
    });

    app.get<{ Params: { code: string } }>("/meta/data-deletion/:code", async (req, reply) => {
      const [r] = await engine.db`select status, created_at, completed_at from data_deletion_requests where confirmation_code = ${req.params.code}`;
      return r ?? reply.status(404).send({ error: "not_found" });
    });
  };

export async function connectAccount(
  deps: Deps,
  workspaceId: string,
  me: { igUserId: string; username: string; name?: string; profilePictureUrl?: string; accountType?: string },
  accessToken: string,
  expiresAt: Date | null,
) {
  const { engine } = deps;
  const enc = await engine.vault.encrypt(accessToken);
  const [existing] = await engine.db<{ workspace_id: string }[]>`select workspace_id from ig_accounts where ig_user_id = ${me.igUserId}`;
  if (existing && existing.workspace_id !== workspaceId) {
    throw Object.assign(new Error("This Instagram account is connected to another workspace"), { statusCode: 409 });
  }
  const [row] = await engine.db<{ id: string }[]>`
    insert into ig_accounts (workspace_id, ig_user_id, username, name, profile_picture_url, account_type, access_token_enc, token_expires_at, status)
    values (${workspaceId}, ${me.igUserId}, ${me.username}, ${me.name ?? null}, ${me.profilePictureUrl ?? null}, ${me.accountType ?? null},
            ${enc}, ${expiresAt}, 'active')
    on conflict (ig_user_id) do update set username = excluded.username, name = excluded.name,
      profile_picture_url = excluded.profile_picture_url, account_type = excluded.account_type,
      access_token_enc = excluded.access_token_enc, token_expires_at = excluded.token_expires_at,
      status = 'active', updated_at = now()
    returning id`;
  await engine.meta.subscribeWebhooks(accessToken, WEBHOOK_FIELDS);
  return row!;
}
