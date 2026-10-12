import type { FastifyPluginAsync } from "fastify";
import type { Deps } from "../app.js";
import { requireRole } from "../auth.js";

export const analyticsRoutes =
  (_deps: Deps): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Querystring: { days?: string } }>("/api/analytics/overview", { preHandler: requireRole("viewer") }, async (req) => {
      const days = Math.min(Math.max(Number(req.query.days ?? 30), 1), 365);
      const since = new Date(Date.now() - days * 86400_000);
      return req.tx(async (tx) => {
        const [totals] = await tx`
          select
            (select count(*)::int from messages where direction = 'out' and status = 'sent' and kind in ('dm', 'private_reply') and created_at >= ${since}) as dms_sent,
            (select count(*)::int from messages where direction = 'out' and status = 'sent' and kind = 'public_reply' and created_at >= ${since}) as public_replies,
            (select count(*)::int from messages where direction = 'out' and status in ('failed', 'skipped') and created_at >= ${since}) as not_delivered,
            (select count(*)::int from messages where direction = 'out' and status in ('queued', 'sending')) as queued,
            (select count(*)::int from messages where direction = 'in' and created_at >= ${since}) as inbound,
            (select count(*)::int from comment_replies where created_at >= ${since}) as comments_triggered,
            (select count(*)::int from contacts where created_at >= ${since}) as new_contacts,
            (select count(*)::int from contacts) as total_contacts,
            (select count(*)::int from link_clicks where contact_id is not null and ts >= ${since}) as dm_link_clicks,
            (select count(distinct contact_id)::int from link_clicks where contact_id is not null and ts >= ${since}) as dm_unique_clickers,
            (select count(*)::int from page_views where ts >= ${since}) as bio_views,
            (select count(*)::int from link_clicks where page_id is not null and ts >= ${since}) as bio_clicks`;

        const daily = await tx`
          with d as (select generate_series(date_trunc('day', ${since}::timestamptz), date_trunc('day', now()), interval '1 day') as day)
          select to_char(d.day, 'YYYY-MM-DD') as day,
            (select count(*)::int from messages m where m.direction = 'out' and m.status = 'sent' and m.kind in ('dm','private_reply') and date_trunc('day', m.created_at) = d.day) as dms,
            (select count(*)::int from link_clicks c where date_trunc('day', c.ts) = d.day) as clicks,
            (select count(*)::int from contacts c where date_trunc('day', c.created_at) = d.day) as contacts
          from d order by d.day`;

        const topKeywords = await tx`
          select keyword, count(*)::int as comments from comment_replies where created_at >= ${since} and keyword is not null
          group by keyword order by comments desc limit 10`;

        const topPosts = await tx`
          select cr.media_id, count(*)::int as comments,
            count(distinct lc.contact_id)::int as clickers
          from comment_replies cr
          left join link_clicks lc on lc.contact_id = cr.contact_id and lc.ts >= cr.created_at
          where cr.created_at >= ${since} and cr.media_id is not null
          group by cr.media_id order by comments desc limit 10`;

        const topLinks = await tx`
          select b.id, b.data->>'title' as title, count(c.id)::int as clicks
          from bio_blocks b left join link_clicks c on c.block_id = b.id and c.ts >= ${since}
          where b.type = 'link' group by b.id order by clicks desc limit 10`;

        // Comment funnel: matched comment → private reply delivered → that person clicked a tracked link.
        const [funnel] = await tx<{ comments: number; dms: number; clicks: number }[]>`
          select count(*)::int as comments,
            count(*) filter (where cr.private_reply_sent_at is not null)::int as dms,
            count(*) filter (where exists (select 1 from link_clicks lc where lc.contact_id = cr.contact_id and lc.ts >= cr.created_at))::int as clicks
          from comment_replies cr where cr.created_at >= ${since}`;
        return { days, totals, daily, topKeywords, topPosts, topLinks, funnel };
      });
    });
  };
