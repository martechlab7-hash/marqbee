import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { performSend, QStashJobs, sweepOutbox } from "../src/index.js";
import { addAutomation, commentPayload, deliver, drain, makeHarness, resetDb, seedAccount, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(resetDb);
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

describe("inline driver (Vercel without QStash)", () => {
  it("processes webhook → DM after the response, never double-sends on redelivery", async () => {
    h = await makeHarness({ driver: "inline" });
    expect(h.engine.jobs.kind).toBe("inline");
    const acc = await seedAccount(h.engine);
    await addAutomation(h.engine, acc, "comment", { keywords: ["link"] }, { publicReplies: ["Sent!"], message: { text: "here" } });
    const body = commentPayload(acc.ig_user_id, { id: "c1", text: "LINK", from: "u1" });
    await Promise.all([deliver(h.engine, body), deliver(h.engine, body), deliver(h.engine, body)]);
    await drain(h.engine);
    expect(h.meta.count("sendPrivateReply")).toBe(1);
    expect(h.meta.count("replyToComment")).toBe(1);
  });

  it("sweeper finishes work left over by a crashed function", async () => {
    h = await makeHarness({ driver: "inline" });
    const acc = await seedAccount(h.engine);
    await addAutomation(h.engine, acc, "comment", { mode: "any" }, { message: { text: "hi" } });
    // Simulate the function dying right after the ack: the event row exists but was never processed.
    await h.engine.db`insert into events (ig_user_id, type, payload, dedupe_key, received_at)
      values (${acc.ig_user_id}, 'comment', ${h.engine.db.json({ kind: "comment", dedupeKey: "comment:lost", igUserId: acc.ig_user_id, commentId: "lost", text: "x", fromId: "u9", isLive: false, occurredAt: new Date().toISOString() })},
      'comment:lost', now() - interval '5 minutes')`;
    await sweepOutbox(h.engine);
    await drain(h.engine);
    expect(h.meta.count("sendPrivateReply")).toBe(1);
  });
});

describe("send lease", () => {
  it("concurrent duplicate deliveries of one send job produce one Meta call", async () => {
    h = await makeHarness({ workers: false });
    h.meta.latencyMs = 100;
    const acc = await seedAccount(h.engine);
    const [c] = await h.engine.db`insert into contacts (workspace_id, ig_account_id, igsid, last_inbound_at)
      values (${acc.workspace_id}, ${acc.id}, 'u1', now()) returning id`;
    const [m] = await h.engine.db`insert into messages (workspace_id, ig_account_id, contact_id, direction, body, payload, status, sent_by)
      values (${acc.workspace_id}, ${acc.id}, ${c!.id}, 'out', 'hi', ${h.engine.db.json({ message: { text: "hi" } })}, 'queued', 'bot') returning id`;
    const results = await Promise.all(Array.from({ length: 5 }, () => performSend(h.engine, m!.id)));
    expect(results.filter((r) => r.status === "sent")).toHaveLength(1);
    expect(h.meta.count("sendMessage")).toBe(1);
  });
});

describe("after Meta accepts a send", () => {
  it("a bookkeeping failure never re-queues it (no double send), and an echo landing first is merged", async () => {
    h = await makeHarness({ workers: false });
    const acc = await seedAccount(h.engine);
    const [c] = await h.engine.db`insert into contacts (workspace_id, ig_account_id, igsid, last_inbound_at)
      values (${acc.workspace_id}, ${acc.id}, 'u1', now()) returning id`;
    const [m] = await h.engine.db`insert into messages (workspace_id, ig_account_id, contact_id, direction, body, payload, status, sent_by)
      values (${acc.workspace_id}, ${acc.id}, ${c!.id}, 'out', 'hi', ${h.engine.db.json({ message: { text: "hi" } })}, 'queued', 'bot') returning id`;
    // Instagram's echo for the same DM arrives before we record the send.
    const orig = h.meta.sendMessage.bind(h.meta);
    h.meta.sendMessage = async (...a) => {
      const r = await orig(...a);
      await h.engine.db`insert into messages (workspace_id, ig_account_id, contact_id, direction, body, meta_message_id, status, sent_by)
        values (${acc.workspace_id}, ${acc.id}, ${c!.id}, 'out', 'hi', ${r.messageId}, 'sent', 'echo')`;
      return r;
    };
    expect(await performSend(h.engine, m!.id)).toEqual({ status: "sent" });
    const rows = await h.engine.db`select sent_by, status, meta_message_id from messages where contact_id = ${c!.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sent_by: "bot", status: "sent" });
    expect(rows[0]!.meta_message_id).toMatch(/^fake_sendMessage/);
    // A second delivery of the job is a no-op.
    expect((await performSend(h.engine, m!.id)).status).toBe("noop");
    expect(h.meta.count("sendMessage")).toBe(1);
  });
});

describe("qstash driver", () => {
  it("publishes to QStash with dedupe ids, delays and retries", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const jobs = new QStashJobs({ token: "tok", baseUrl: "https://app.example.com" }, (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response("{}", { status: 201 });
    }) as typeof fetch);
    await jobs.event(42n);
    await jobs.send("m1", { delayMs: 61_500, attempt: 2 });
    expect(calls[0]).toMatchObject({ url: "https://qstash.upstash.io/v2/publish/https://app.example.com/internal/jobs/event", body: '{"eventId":"42"}' });
    expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer tok", "Upstash-Deduplication-Id": "evt-42", "Upstash-Retries": "5" });
    expect(calls[1]!.headers).toMatchObject({ "Upstash-Deduplication-Id": "send-m1-2", "Upstash-Delay": "62s" });
  });
});
