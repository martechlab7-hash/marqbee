import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { isValidSlug, normalizeSlug } from "@marqbee/core";
import type { Tx } from "@marqbee/db";
import type { Deps } from "../app.js";
import { audit, requireRole } from "../auth.js";

const httpUrl = z.string().url().refine((u) => /^https?:\/\//.test(u), "must be http(s)");

const Block = z.discriminatedUnion("type", [
  z.object({ id: z.string().uuid().optional(), type: z.literal("link"), enabled: z.boolean().default(true), data: z.object({ title: z.string().min(1).max(80), url: httpUrl, thumbnail: httpUrl.optional(), highlight: z.boolean().optional(), utm: z.record(z.string().max(100)).optional() }) }),
  z.object({ id: z.string().uuid().optional(), type: z.literal("header"), enabled: z.boolean().default(true), data: z.object({ text: z.string().min(1).max(80) }) }),
  z.object({ id: z.string().uuid().optional(), type: z.literal("text"), enabled: z.boolean().default(true), data: z.object({ text: z.string().min(1).max(500) }) }),
  z.object({ id: z.string().uuid().optional(), type: z.literal("youtube"), enabled: z.boolean().default(true), data: z.object({ url: httpUrl }) }),
  z.object({ id: z.string().uuid().optional(), type: z.literal("spotify"), enabled: z.boolean().default(true), data: z.object({ url: httpUrl }) }),
  z.object({
    id: z.string().uuid().optional(),
    type: z.literal("socials"),
    enabled: z.boolean().default(true),
    data: z.object({ links: z.array(z.object({ network: z.enum(["instagram", "youtube", "x", "linkedin", "whatsapp", "email", "website", "threads"]), url: z.string().max(300) })).max(10) }),
  }),
]);

const PageBody = z.object({
  slug: z.string().min(2).max(40),
  title: z.string().max(80),
  bio: z.string().max(300),
  avatarUrl: httpUrl.nullable().optional(),
  theme: z.object({ preset: z.enum(["sunrise", "midnight", "mint", "paper", "candy"]), buttonStyle: z.enum(["rounded", "pill", "square"]).optional() }),
  showBadge: z.boolean(),
  published: z.boolean(),
  blocks: z.array(Block).max(50),
});

async function getOrCreatePage(tx: Tx, workspaceId: string) {
  const [p] = await tx`select * from bio_pages order by created_at limit 1`;
  if (p) return p;
  const [w] = await tx<{ name: string }[]>`select name from workspaces where id = ${workspaceId}`;
  let slug = normalizeSlug(w!.name) || "creator";
  if (!isValidSlug(slug)) slug = `creator-${slug}`.slice(0, 30);
  const [taken] = await tx`select 1 from bio_pages where slug = ${slug}`;
  if (taken) slug = `${slug.slice(0, 30)}-${Math.random().toString(36).slice(2, 6)}`;
  const [created] = await tx`insert into bio_pages (workspace_id, slug, title) values (${workspaceId}, ${slug}, ${w!.name}) returning *`;
  return created!;
}

export const bioRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/bio", { preHandler: requireRole("viewer") }, async (req) =>
      req.tx(async (tx) => {
        const page = await getOrCreatePage(tx, req.auth!.workspaceId);
        const blocks = await tx`select id, type, data, enabled from bio_blocks where page_id = ${page.id} order by position`;
        const [plan] = await tx<{ plan: string }[]>`select plan from workspaces`;
        return { ...page, blocks, plan: plan!.plan };
      }),
    );

    app.put("/api/bio", { preHandler: requireRole("admin") }, async (req, reply) => {
      const b = PageBody.parse(req.body);
      const slug = normalizeSlug(b.slug);
      if (!isValidSlug(slug)) return reply.status(422).send({ error: "validation_failed", issues: ["That URL isn't available"] });
      return req.tx(async (tx) => {
        const page = await getOrCreatePage(tx, req.auth!.workspaceId);
        // Slugs are globally unique; check across tenants with the service connection.
        const [clash] = await deps.engine.db`select 1 from bio_pages where slug = ${slug} and id <> ${page.id}`;
        if (clash) return reply.status(409).send({ error: "That URL is taken" });
        const [plan] = await tx<{ plan: string }[]>`select plan from workspaces`;
        await tx`
          update bio_pages set slug = ${slug}, title = ${b.title}, bio = ${b.bio}, avatar_url = ${b.avatarUrl ?? null},
            theme = ${tx.json(b.theme)}, show_badge = ${plan!.plan === "free" ? true : b.showBadge}, published = ${b.published}, updated_at = now()
          where id = ${page.id}`;
        // Keep block ids stable (click history references them); delete removed ones.
        const keep = b.blocks.map((x) => x.id).filter((x): x is string => !!x);
        await tx`delete from bio_blocks where page_id = ${page.id} and not (id = any(${keep}::uuid[]))`;
        for (const [i, blk] of b.blocks.entries()) {
          if (blk.id) {
            await tx`update bio_blocks set position = ${i}, type = ${blk.type}, data = ${tx.json(blk.data as never)}, enabled = ${blk.enabled}
                     where id = ${blk.id} and page_id = ${page.id}`;
          } else {
            await tx`insert into bio_blocks (workspace_id, page_id, position, type, data, enabled)
                     values (${req.auth!.workspaceId}, ${page.id}, ${i}, ${blk.type}, ${tx.json(blk.data as never)}, ${blk.enabled})`;
          }
        }
        await audit(tx, req, "update", "bio_page", page.id as string, { slug, blocks: b.blocks.length });
        const blocks = await tx`select id, type, data, enabled from bio_blocks where page_id = ${page.id} order by position`;
        return { ok: true, slug, blocks };
      });
    });
  };
