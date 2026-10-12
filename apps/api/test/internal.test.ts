import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type Sql } from "@marqbee/db";
import { QStashJobs } from "@marqbee/engine";
import { buildApp } from "../src/app.js";
import { addAutomation, commentPayload, deliver, makeHarness, resetDb, seedAccount, TEST_DB_APP, type Harness } from "../../../packages/engine/test/helpers.js";

/** Signs a request body exactly like QStash (HS256 JWT, iss=Upstash, body=base64url(sha256(body))). */
function qstashSign(body: string, key: string, url = "https://app.example.com/internal/jobs/x") {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const claims = b64({ iss: "Upstash", sub: url, iat: now, nbf: now, exp: now + 300, jti: String(Math.random()), body: createHash("sha256").update(body).digest("base64url") });
  return `${head}.${claims}.${createHmac("sha256", key).update(`${head}.${claims}`).digest("base64url")}`;
}

let h: Harness;
let appDb: Sql;
let app: FastifyInstance;
const published: { url: string; body: string; headers: Record<string, string> }[] = [];

beforeEach(async () => {
  await resetDb();
  published.length = 0;
  h = await makeHarness({ workers: false });
  // Swap in the QStash driver with a fake HTTP endpoint that records publishes.
  h.engine.config = { ...h.engine.config, jobDriver: "qstash", cronSecret: "cron-s3cret", qstash: { token: "t", currentSigningKey: "sig-current", nextSigningKey: "sig-next" } };
  h.engine.jobs = new QStashJobs({ token: "t", baseUrl: "https://app.example.com" }, (async (url: string, init: RequestInit) => {
    published.push({ url: String(url), body: String(init.body), headers: init.headers as Record<string, string> });
    return new Response("{}", { status: 201 });
  }) as typeof fetch);
  appDb = createDb(TEST_DB_APP, { max: 2 });
  app = await buildApp({ engine: h.engine, appDb }, { logger: false });
});
afterEach(async () => {
  await app.close();
  await appDb.end();
  await h.close();
});

/** Plays the role of QStash: deliver every published job to the app, signed. */
async function deliverPublished() {
  let n = 0;
  while (published.length) {
    const p = published.shift()!;
    const path = p.url.split("https://app.example.com")[1]!;
    const r = await app.inject({ method: "POST", url: path, payload: p.body, headers: { "content-type": "application/json", "upstash-signature": qstashSign(p.body, "sig-current") } });
    expect(r.statusCode).toBe(200);
    n++;
  }
  return n;
}

it("QStash: webhook → event job → send jobs, signature required", async () => {
  const acc = await seedAccount(h.engine);
  await addAutomation(h.engine, acc, "comment", { keywords: ["link"] }, { publicReplies: ["Sent"], message: { text: "hi" } });
  await deliver(h.engine, commentPayload(acc.ig_user_id, { id: "c1", text: "link", from: "u1" }));
  expect(published.map((p) => p.headers["Upstash-Deduplication-Id"])).toEqual(["evt-1"]);

  const unsigned = await app.inject({ method: "POST", url: "/internal/jobs/event", payload: { eventId: "1" } });
  expect(unsigned.statusCode).toBe(401);
  const forged = await app.inject({ method: "POST", url: "/internal/jobs/event", payload: '{"eventId":"1"}', headers: { "content-type": "application/json", "upstash-signature": qstashSign('{"eventId":"1"}', "wrong-key") } });
  expect(forged.statusCode).toBe(401);

  expect(await deliverPublished()).toBe(3); // event, then private reply + public reply
  expect(h.meta.count("sendPrivateReply")).toBe(1);
  expect(h.meta.count("replyToComment")).toBe(1);
});

it("QStash: rate-limited send is re-published with a delay instead of failing", async () => {
  const acc = await seedAccount(h.engine);
  await h.engine.limiter.pause(acc.id, 30_000);
  const [c] = await h.engine.db`insert into contacts (workspace_id, ig_account_id, igsid, last_inbound_at) values (${acc.workspace_id}, ${acc.id}, 'u', now()) returning id`;
  const [m] = await h.engine.db`insert into messages (workspace_id, ig_account_id, contact_id, direction, body, payload, status, sent_by)
    values (${acc.workspace_id}, ${acc.id}, ${c!.id}, 'out', 'x', ${h.engine.db.json({ message: { text: "x" } })}, 'queued', 'bot') returning id`;
  const body = JSON.stringify({ messageId: m!.id });
  const r = await app.inject({ method: "POST", url: "/internal/jobs/send", payload: body, headers: { "content-type": "application/json", "upstash-signature": qstashSign(body, "sig-next") } });
  expect(r.json()).toMatchObject({ status: "delay" });
  expect(published).toHaveLength(1);
  expect(Number(published[0]!.headers["Upstash-Delay"]!.replace("s", ""))).toBeGreaterThanOrEqual(29);
  const [row] = await h.engine.db`select status from messages where id = ${m!.id}`;
  expect(row!.status).toBe("queued");
});

it("cron endpoints require the Vercel CRON_SECRET or a QStash signature", async () => {
  expect((await app.inject({ method: "GET", url: "/internal/cron/sweep" })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/internal/cron/sweep", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
  const ok = await app.inject({ method: "GET", url: "/internal/cron/sweep", headers: { authorization: "Bearer cron-s3cret" } });
  expect(ok.json()).toMatchObject({ ok: true, result: { events: 0, sends: 0, resumes: 0 } });
  const viaQStash = await app.inject({ method: "POST", url: "/internal/cron/expire-runs", payload: "", headers: { "upstash-signature": qstashSign("", "sig-current") } });
  expect(viaQStash.statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/internal/cron/nope", headers: { authorization: "Bearer cron-s3cret" } })).statusCode).toBe(404);
});
