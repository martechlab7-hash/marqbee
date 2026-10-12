# Marqbee

An Instagram growth and conversion OS for Indian creators and D2C brands. It combines a link-in-bio page, comment-to-DM and DM automations, a shared inbox and a contact CRM, all on Meta's official Instagram API.

This repo is the **Foundation + Core MVP** from the production plan (weeks 1–10): a working end-to-end product that runs locally without a Meta app, and against Instagram once one is configured.

## What's built

| Module | Status |
|---|---|
| **Comment-to-DM** | Keyword triggers per post/reel or across all posts, any-comment trigger, rotating public replies, a DM with link buttons, a "follow first" gate, and a rate-limited queue for viral posts with an ETA |
| **DM automation** | DM keyword replies, welcome message, story-reply and story-mention triggers, quick replies/postbacks |
| **Inbox** | Unified inbox, pause the bot per contact, saved replies, 24h window shown on every thread, human-agent tag (7 days, only from the inbox), assignment filter |
| **Contacts** | Auto-captured with source (post, keyword, trigger), tags, email/phone, follower status, CSV export, erasure (DPDP) |
| **Link-in-bio** | Mobile page builder with live preview: links, headers, text, YouTube, Spotify, socials; 5 themes, custom slug, per-link UTMs, view and click analytics, "Made with Marqbee" badge on the free plan |
| **Analytics** | DMs sent, comments answered, DM link click rate (tracked `/r/` links per contact), comment → DM → click funnel, top keywords and posts, bio CTR, daily chart |
| **Workspace** | Multiple IG accounts, team seats with roles (owner/admin/agent/viewer), workspace switcher, audit log |
| **Meta platform** | Instagram Login OAuth, long-lived token exchange and refresh, webhook verify + signature check, deauthorize and data-deletion callbacks, privacy/terms/data-deletion pages |

## Architecture

```
Meta webhooks ─▶ API /webhooks/instagram ─▶ events (Postgres, unique dedupe_key) ─▶ BullMQ "events"
                 verify X-Hub-Signature-256,                                         │
                 store raw, ack < 1s                                                 ▼
                                                                  Flow engine (event processor)
                                                                  contact upsert · trigger match ·
                                                                  one-claim-per-comment · flow run ·
                                                                  outbound rows (transactional outbox)
                                                                                     │
                                                                                     ▼
                                              Send worker (the only code that calls Meta)
                                              per-account Redis token bucket @ 80% of 750/h ·
                                              24h window checked at send time · retries ·
                                              dead letters · needs-reconnect on auth errors
```

A modular monolith in TypeScript (pnpm workspaces):

- `packages/core`: pure domain logic: webhook normalisation, signature checks, keyword matching (Hindi works too), messaging windows, envelope token encryption, rate limiter, Meta client (live + fake), OAuth, flow graph compiler and runtime.
- `packages/db`: Postgres schema and migrator. Every tenant table has `workspace_id` with **row-level security**. The dashboard API connects as `marqbee_app` (RLS enforced); ingest and workers use `marqbee_service` (BYPASSRLS).
- `packages/engine`: ingest, event processor, flow runs, send worker, and maintenance jobs: outbox sweeper, comment reconciliation for missed webhooks, token refresh, run expiry.
- `apps/api`: Fastify API, auth (scrypt, hashed session tokens, origin check), all dashboard and public endpoints.
- `apps/worker`: BullMQ worker process. Scale it horizontally.
- `apps/web`: Next.js 15 + Tailwind 4 dashboard and public bio pages (`/[slug]`, cached 60s).

### Guarantees (tested)

- **No duplicate DM.** A unique `events.dedupe_key` blocks replays, a `comment_replies.comment_id` primary key claims each comment once, `messages.idempotency_key` covers every send, and BullMQ jobIds are message ids.
- **No lost webhook.** The raw body is stored before anything else. Events and sends are committed to Postgres before they're queued, and a sweeper re-queues anything Redis missed. Reconciliation polls recent comments to catch webhooks Meta never sent.
- **No account ban.** Sends are paced per account, Meta rate-limit errors (80002 etc.) pause that account, there are no cold DMs, and the follow gate and public replies rotate.
- **No leaked token.** Tokens use AES-256-GCM envelope encryption (the key wrapper can be swapped for KMS), pino redacts them from logs, and they're wiped on deauthorize.

The beta-gate load test (`packages/engine/test/load.test.ts`) sends **50,000 comments plus 50,000 non-matching comments, every webhook delivered twice**. Result: **50,000 private replies, 0 duplicates, 0 dead letters**, at about 410 DMs/s with the rate limiter lifted. Run it with `LOAD_COMMENTS=50000 pnpm --filter @marqbee/engine test`.

## Run it locally

Requirements: Node 22, pnpm 10, Postgres 16, Redis 7 (or `docker compose up -d`).

```bash
pnpm install
cp .env.example .env               # defaults work for local dev
# create roles + databases + run migrations (as a Postgres superuser)
EXTRA_DBS=marqbee_test pnpm db:setup        # with docker: PGUSER=postgres PGPASSWORD=postgres PGHOST=localhost …
pnpm dev                           # api :4000, worker, web :3000
```

With no `META_APP_SECRET` set, the app runs in **dev mode** (`META_CLIENT=fake`): sends are recorded, not delivered. Sign up at http://localhost:3000, then on **Instagram accounts** use *Developer tools* to connect a simulated account and fire signed webhooks (comment, DM, story mention, "I followed" tap) through the real pipeline. The outbox panel shows exactly what would have been sent to Meta.

Tests (need Postgres + Redis): `pnpm test`. Typecheck: `pnpm typecheck`.

## Deploy on Vercel (one project)

Everything — dashboard, bio pages, API, webhooks and background jobs — deploys as a single Vercel project:

- The Fastify API runs inside Next.js route handlers (`apps/web/lib/backend.ts`), so `/api`, `/webhooks`, `/oauth`, `/meta`, `/r`, `/b` all live on your one domain.
- Background work (event processing, DM sends, flow waits) goes through **Upstash QStash**, which calls back `/internal/jobs/*` with signed requests, delays, retries and deduplication. Without QStash it falls back to running after the response via `waitUntil`, with a daily cron sweep (fine for testing, not for production).
- Maintenance (outbox sweep, missed-comment reconciliation, token refresh) runs on QStash schedules registered at deploy time, plus a daily Vercel Cron as a safety net. Both work on the Hobby plan.

**Steps**

1. **Import the repo:** Vercel → Add New → Project → `marqbee`. Set **Root Directory = `apps/web`**. Everything else is read from `apps/web/vercel.json`.
2. **Add storage** (Project → Storage, all from the Vercel Marketplace, free tiers available):
   - **Neon** (Postgres). It sets `DATABASE_URL` / `DATABASE_URL_UNPOOLED`. Choose the region closest to your users (Singapore for India), and set the project's Function Region (Settings → Functions) to match.
   - **Upstash for Redis.** It sets `REDIS_URL` / `KV_URL`. Same region.
   - **Upstash QStash.** It sets `QSTASH_TOKEN`, `QSTASH_URL`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`.
3. **Add environment variables** (Settings → Environment Variables):

   | Variable | Value |
   |---|---|
   | `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32`. Store it safely and **never change it** (changing it breaks every connected account). |
   | `SESSION_SECRET` | any long random string |
   | `DATABASE_APP_PASSWORD` | any long random string. The dashboard connects as a separate `marqbee_app` role so row-level security isolates workspaces; it's created automatically. |
   | `CRON_SECRET` | any long random string (Vercel sends it to the cron endpoints) |
   | `META_CLIENT` | `fake` until your Meta app is approved. Sends are simulated and the Accounts page has a simulator. |
   | `PUBLIC_WEB_URL` | optional: your custom domain, e.g. `https://marqbee.in`. Defaults to the Vercel production URL. |

4. **Deploy.** The build runs migrations, registers the QStash schedules, then builds Next.js. Open `https://<your-app>/health`: it should show `{"ok":true,"jobs":"qstash",...}`.

**Notes**
- **Costs:** Vercel Hobby, Neon, Upstash Redis and QStash all have free tiers. QStash's free daily message quota covers testing; one comment-to-DM uses about 3 messages (event + DM + public reply), so switch QStash to pay-as-you-go before real launches.
- **Preview deployments** share the production environment variables unless you scope them, so attach a separate Neon branch to Preview (the Neon integration can do this automatically).
- **Commercial use:** Vercel Hobby is for non-commercial use, so move to Pro before charging customers.

### Alternative: split hosting

`render.yaml` runs the API, worker, Postgres and Redis on Render with BullMQ workers, which suits very high volume. In that setup, set `API_INTERNAL_URL` on the Vercel project to the Render API URL, and Next.js proxies the API paths to it.

## Going live with Meta

On a single Vercel project, `{PUBLIC_API_URL}` and `{PUBLIC_WEB_URL}` below are both your app's URL.

1. Create a Meta app (type *Business*) and add **Instagram → API setup with Instagram login**.
2. Set `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`), `PUBLIC_API_URL`, `PUBLIC_WEB_URL`.
3. Configure in the Meta dashboard:
   - OAuth redirect: `{PUBLIC_API_URL}/oauth/instagram/callback`
   - Webhook callback: `{PUBLIC_API_URL}/webhooks/instagram`. Subscribe to `comments`, `live_comments`, `messages`, `messaging_postbacks`.
   - Deauthorize callback: `{PUBLIC_API_URL}/meta/deauthorize`
   - Data deletion callback: `{PUBLIC_API_URL}/meta/data-deletion`
   - Privacy policy: `{PUBLIC_WEB_URL}/privacy`
4. Add test Instagram accounts, then **submit App Review** for `instagram_business_basic`, `instagram_business_manage_messages` and `instagram_business_manage_comments`, with a screencast per permission. Do this by week 4: it's the longest external dependency.

The Graph API version is pinned via `META_GRAPH_VERSION` (default `v23.0`). Check it against Meta's version schedule with every release.

## Roadmap: what's next

Following the plan's phases:

- **Private beta (weeks 11–14):** Razorpay Subscriptions (UPI autopay, GST invoices) and plan enforcement/usage metering, OpenTelemetry + Sentry + queue dashboards and alerts, status page, PITR backups with a tested restore, email invites, template gallery, a staging Meta app, and a load test against real Meta sandbox limits.
- **Growth / v2 (weeks 15–26):** a visual flow builder on React Flow (the graph model and runtime in `packages/core/src/flow` are already in place: conditions, waits under 24h, tags, reply routing), segments and broadcasts inside the window, Shopify/Razorpay revenue attribution (the `conversions` table and per-contact tracked links are ready), agency workspaces and white-label, and AI intent matching and suggested replies via the Claude API.
- **Infrastructure:** swap `LocalKeyWrapper` for AWS KMS, deploy to AWS Mumbai (ap-south-1), move `link_clicks` to ClickHouse once volume justifies it, add SSO/2FA.
