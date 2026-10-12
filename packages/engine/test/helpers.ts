import { randomBytes } from "node:crypto";
import { FakeMetaClient, signMetaPayload, type AutomationConfig, type TriggerConfig, type TriggerKind } from "@marqbee/core";
import { createDb, migrate } from "@marqbee/db";
import { pino } from "pino";
import { createAutomation, createEngine, ingestWebhook, loadConfig, startWorkers, type Engine } from "../src/index.js";

export const TEST_DB_SERVICE = process.env.TEST_DATABASE_SERVICE_URL ?? "postgres://marqbee_service:marqbee_service@localhost:5432/marqbee_test";
export const TEST_DB_APP = process.env.TEST_DATABASE_URL ?? "postgres://marqbee_app:marqbee_app@localhost:5432/marqbee_test";

const TABLES = [
  "audit_log", "saved_replies", "conversions", "tracked_links", "link_clicks", "page_views", "bio_blocks", "bio_pages",
  "dead_letters", "comment_replies", "messages", "events", "webhook_deliveries", "flow_runs", "automations",
  "flow_versions", "flows", "contacts", "ig_accounts", "sessions", "oauth_states", "memberships", "users", "workspaces",
  "data_deletion_requests",
];

export async function resetDb() {
  const sql = createDb(TEST_DB_SERVICE, { max: 1 });
  await migrate(sql);
  await sql.unsafe(`update flows set current_version_id = null; truncate ${TABLES.join(", ")} restart identity cascade`);
  await sql.end();
}

export interface Harness {
  engine: Engine;
  meta: FakeMetaClient;
  workers?: { close(): Promise<void> };
  close(): Promise<void>;
}

export async function makeHarness(opts: { sendsPerHour?: number; workers?: boolean } = {}): Promise<Harness> {
  const prefix = `test-${randomBytes(4).toString("hex")}`;
  const meta = new FakeMetaClient();
  const config = {
    ...loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
    databaseServiceUrl: TEST_DB_SERVICE,
    databaseUrl: TEST_DB_APP,
    metaAppSecret: "test-secret",
    tokenEncryptionKey: randomBytes(32).toString("base64"),
    sendsPerHour: opts.sendsPerHour ?? 10_000_000,
  };
  const engine = createEngine(config, { meta, prefix, log: pino({ level: process.env.TEST_LOG ?? "silent" }) });
  const workers = opts.workers === false ? undefined : await startWorkers(engine, { eventConcurrency: 20, sendConcurrency: 20 });
  return {
    engine,
    meta,
    workers,
    async close() {
      await workers?.close();
      for (const q of Object.values(engine.queues)) await q.obliterate({ force: true }).catch(() => {});
      const keys = await engine.redis.keys(`${prefix}*`);
      if (keys.length) await engine.redis.del(...keys);
      await engine.close();
    },
  };
}

export async function seedAccount(engine: Engine, igUserId = "17841400000000001") {
  const [ws] = await engine.db<{ id: string }[]>`insert into workspaces (name) values ('Test WS') returning id`;
  const enc = await engine.vault.encrypt("test-access-token");
  const [acc] = await engine.db<{ id: string; workspace_id: string; ig_user_id: string }[]>`
    insert into ig_accounts (workspace_id, ig_user_id, username, access_token_enc, token_expires_at)
    values (${ws!.id}, ${igUserId}, 'creator', ${enc}, now() + interval '50 days') returning id, workspace_id, ig_user_id`;
  return acc!;
}

export async function addAutomation(
  engine: Engine,
  acc: { id: string; workspace_id: string },
  type: TriggerKind,
  trigger: Partial<TriggerConfig>,
  config: AutomationConfig,
) {
  return engine.db.begin((tx) =>
    createAutomation(tx, acc.workspace_id, {
      igAccountId: acc.id,
      name: `${type} automation`,
      type,
      trigger: { mode: "contains", keywords: [], ...trigger },
      config,
    }),
  );
}

export function commentPayload(igUserId: string, c: { id: string; text: string; from: string; media?: string; parentId?: string }) {
  return {
    object: "instagram",
    entry: [
      {
        id: igUserId,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: "comments",
            value: { id: c.id, text: c.text, from: { id: c.from, username: `u_${c.from}` }, media: { id: c.media ?? "media1" }, parent_id: c.parentId },
          },
        ],
      },
    ],
  };
}

export function messagingPayload(igUserId: string, m: Record<string, unknown>) {
  return { object: "instagram", entry: [{ id: igUserId, time: Math.floor(Date.now() / 1000), messaging: [{ recipient: { id: igUserId }, timestamp: Date.now(), ...m }] }] };
}

export async function deliver(engine: Engine, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  return ingestWebhook(engine, raw, signMetaPayload(raw, engine.config.metaAppSecret));
}

export async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 20_000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Wait until every queue is empty and no messages are pending. */
export async function drain(engine: Engine, timeoutMs = 30_000) {
  await waitFor(
    async () => {
      const counts = await Promise.all(Object.values(engine.queues).map((q) => q.getJobCounts("waiting", "active", "delayed", "prioritized")));
      const busy = counts.some((c) => Object.values(c).some((n) => Number(n) > 0));
      if (busy) return false;
      const [p] = await engine.db<{ n: number }[]>`select count(*)::int n from messages where status in ('queued','sending')`;
      const [e] = await engine.db<{ n: number }[]>`select count(*)::int n from events where processed_at is null`;
      return p!.n === 0 && e!.n === 0;
    },
    timeoutMs,
    "queues to drain",
  );
}
