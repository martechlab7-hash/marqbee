import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Deps } from "../app.js";

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

function utmFrom(q: Record<string, string | undefined>) {
  return Object.fromEntries(UTM_KEYS.filter((k) => q[k]).map((k) => [k, q[k]!.slice(0, 200)]));
}

function country(req: FastifyRequest): string | null {
  return ((req.headers["cf-ipcountry"] ?? req.headers["x-vercel-ip-country"] ?? req.headers["cloudfront-viewer-country"]) as string | undefined) ?? null;
}

function safeUrl(u: string): string | null {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Unauthenticated endpoints: bio page data, click + view logging, tracked DM links. */
export const publicRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps.engine;

    app.get<{ Params: { slug: string } }>("/public/bio/:slug", async (req, reply) => {
      const [page] = await db`
        select p.id, p.slug, p.title, p.bio, p.avatar_url, p.theme, p.show_badge, w.plan
        from bio_pages p join workspaces w on w.id = p.workspace_id
        where p.slug = ${req.params.slug.toLowerCase()} and p.published`;
      if (!page) return reply.status(404).send({ error: "not_found" });
      const blocks = await db`select id, type, data from bio_blocks where page_id = ${page.id} and enabled order by position`;
      reply.header("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
      return { ...page, show_badge: page.plan === "free" ? true : page.show_badge, blocks };
    });

    app.post<{ Params: { slug: string }; Body: { referrer?: string; utm?: Record<string, string> } }>("/public/bio/:slug/view", async (req) => {
      await db`
        insert into page_views (workspace_id, page_id, referrer, utm)
        select workspace_id, id, ${req.body?.referrer?.slice(0, 500) ?? null}, ${db.json(utmFrom(req.body?.utm ?? {}))}
        from bio_pages where slug = ${req.params.slug.toLowerCase()}`;
      return { ok: true };
    });

    // Bio link click: log, then redirect. Per-link UTMs are appended to the destination.
    app.get<{ Params: { blockId: string }; Querystring: Record<string, string> }>("/b/:blockId", async (req, reply) => {
      if (!/^[0-9a-f-]{36}$/.test(req.params.blockId)) return reply.status(404).send();
      const [b] = await db<{ workspace_id: string; page_id: string; data: { url?: string; utm?: Record<string, string> } }[]>`
        select workspace_id, page_id, data from bio_blocks where id = ${req.params.blockId} and enabled`;
      const dest = b?.data.url ? safeUrl(b.data.url) : null;
      if (!b || !dest) return reply.status(404).send({ error: "not_found" });
      const url = new URL(dest);
      for (const [k, v] of Object.entries(b.data.utm ?? {})) if (v && !url.searchParams.has(k)) url.searchParams.set(k, v);
      await db`
        insert into link_clicks (workspace_id, page_id, block_id, url, utm, ua, referrer, country)
        values (${b.workspace_id}, ${b.page_id}, ${req.params.blockId}, ${url.toString()}, ${db.json(utmFrom(req.query))},
                ${req.headers["user-agent"]?.slice(0, 300) ?? null}, ${req.headers.referer?.slice(0, 500) ?? null}, ${country(req)})`;
      return reply.redirect(url.toString(), 302);
    });

    // Tracked link inside a DM: attributes the click to the contact and automation.
    app.get<{ Params: { code: string } }>("/r/:code", async (req, reply) => {
      const [l] = await db<{ workspace_id: string; url: string; contact_id: string | null; automation_id: string | null }[]>`
        select workspace_id, url, contact_id, automation_id from tracked_links where code = ${req.params.code}`;
      const dest = l ? safeUrl(l.url) : null;
      if (!l || !dest) return reply.status(404).send({ error: "not_found" });
      await db`
        insert into link_clicks (workspace_id, contact_id, automation_id, url, ua, referrer, country)
        values (${l.workspace_id}, ${l.contact_id}, ${l.automation_id}, ${dest}, ${req.headers["user-agent"]?.slice(0, 300) ?? null},
                ${req.headers.referer?.slice(0, 500) ?? null}, ${country(req)})`;
      return reply.redirect(dest, 302);
    });
  };
