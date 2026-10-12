/**
 * Runs before `next build` on Vercel:
 *  1. Database migrations (and the RLS app role) on Neon/Postgres.
 *  2. On production deploys with QStash: upsert maintenance schedules
 *     (outbox sweep, missed-comment reconciliation, run expiry).
 * Vercel Cron (vercel.json) also calls these daily as a safety net, which
 * works on the Hobby plan.
 */
import { runMigrations } from "@marqbee/db";

const env = process.env;

if (!env.DATABASE_URL && !env.DATABASE_SERVICE_URL) {
  console.error(
    "\n✖ No database configured. In Vercel → Storage, connect a Neon Postgres database to this project, " +
      "then add DATABASE_APP_PASSWORD (any long random string) and redeploy.\n",
  );
  process.exit(1);
}

if (!env.DATABASE_SERVICE_URL && !env.DATABASE_APP_PASSWORD && !env.DATABASE_APP_URL) {
  console.error(
    "\n✖ Add DATABASE_APP_PASSWORD (any long random string) in Vercel → Settings → Environment Variables. " +
      "The dashboard connects as a separate marqbee_app role so Postgres row-level security keeps workspaces isolated.\n",
  );
  process.exit(1);
}

await runMigrations(env, (m) => console.log(`[migrate] ${m}`));

const SCHEDULES: [id: string, path: string, cron: string][] = [
  ["mqb-sweep", "/internal/cron/sweep", "*/10 * * * *"],
  ["mqb-reconcile", "/internal/cron/reconcile", "*/30 * * * *"],
  ["mqb-expire-runs", "/internal/cron/expire-runs", "0 * * * *"],
];

if (env.QSTASH_TOKEN && env.VERCEL_ENV === "production") {
  const base = env.PUBLIC_API_URL || env.PUBLIC_WEB_URL || `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  const qstash = env.QSTASH_URL || "https://qstash.upstash.io";
  for (const [id, path, cron] of SCHEDULES) {
    const res = await fetch(`${qstash}/v2/schedules/${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.QSTASH_TOKEN}`, "Upstash-Cron": cron, "Upstash-Schedule-Id": id, "Upstash-Retries": "2" },
    });
    console.log(`[qstash] schedule ${id} (${cron}) → ${res.ok ? "ok" : `failed ${res.status} ${await res.text()}`}`);
  }
} else {
  console.log("[qstash] not configured or not production — skipping schedules (Vercel Cron still runs daily)");
}
