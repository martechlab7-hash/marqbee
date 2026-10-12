import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MetaApiError, FOLLOW_CHECK_PAYLOAD } from "@marqbee/core";
import { ingestWebhook, performSend, reconcileComments, sweepOutbox } from "../src/index.js";
import { addAutomation, commentPayload, deliver, drain, makeHarness, messagingPayload, resetDb, seedAccount, waitFor, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await h?.close();
});

const DM = { text: "Hey {{username}}! Here's the recipe 👇", buttons: [{ type: "url" as const, title: "Open recipe", url: "https://example.com/recipe" }] };

describe("webhook ingest", () => {
  it("rejects bad signatures and stores nothing", async () => {
    h = await makeHarness({ workers: false });
    const raw = Buffer.from(JSON.stringify(commentPayload("x", { id: "c", text: "hi", from: "u" })));
    expect(await ingestWebhook(h.engine, raw, "sha256=deadbeef")).toEqual({ ok: false, status: 401 });
    const [n] = await h.engine.db`select count(*)::int n from webhook_deliveries`;
    expect(n!.n).toBe(0);
  });

  it("acks fast and dedupes redeliveries at the event level", async () => {
    h = await makeHarness({ workers: false });
    const acc = await seedAccount(h.engine);
    const body = commentPayload(acc.ig_user_id, { id: "c1", text: "LINK", from: "u1" });
    const t = Date.now();
    expect(await deliver(h.engine, body)).toEqual({ ok: true, accepted: 1, duplicates: 0 });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(await deliver(h.engine, body)).toEqual({ ok: true, accepted: 0, duplicates: 1 });
  });
});

describe("comment-to-DM", () => {
  it("sends one private reply + public reply, captures the contact with source", async () => {
    h = await makeHarness();
    const acc = await seedAccount(h.engine);
    const a = await addAutomation(h.engine, acc, "comment", { keywords: ["link"] }, { publicReplies: ["Check your DMs 📩"], message: DM, tags: ["recipe"] });
    await deliver(h.engine, commentPayload(acc.ig_user_id, { id: "c1", text: "LINK please!!", from: "u1", media: "reel9" }));
    await drain(h.engine);

    expect(h.meta.count("sendPrivateReply")).toBe(1);
    expect(h.meta.count("replyToComment")).toBe(1);
    const [, commentId, msg] = h.meta.calls.find((c) => c.method === "sendPrivateReply")!.args as [string, string, { text: string; buttons: { url: string }[] }];
    expect(commentId).toBe("c1");
    expect(msg.text).toBe("Hey u_u1! Here's the recipe 👇");
    expect(msg.buttons[0]!.url).toMatch(/\/r\/[\w-]+$/); // tracked link

    const [contact] = await h.engine.db`select * from contacts`;
    expect(contact).toMatchObject({ igsid: "u1", username: "u_u1", tags: ["recipe"] });
    expect(contact!.source).toMatchObject({ type: "comment", automationId: a.id, mediaId: "reel9", keyword: "link" });
    const [cr] = await h.engine.db`select * from comment_replies`;
    expect(cr!.private_reply_sent_at).not.toBeNull();
    expect(cr!.public_reply_id).not.toBeNull();
  });

  it("never double-sends: same comment redelivered 5x concurrently plus reconciliation", async () => {
    h = await makeHarness();
    const acc = await seedAccount(h.engine);
    await addAutomation(h.engine, acc, "comment", { mode: "any" }, { publicReplies: ["Sent!"], message: { text: "hi" } });
    const body = commentPayload(acc.ig_user_id, { id: "dup", text: "anything", from: "u1" });
    await Promise.all(Array.from({ length: 5 }, () => deliver(h.engine, body)));
    h.meta.listRecentComments = async () => [{ id: "dup", text: "anything", timestamp: new Date().toISOString(), fromId: "u1", mediaId: "media1" }];
    await reconcileComments(h.engine);
    await drain(h.engine);
    await sweepOutbox(h.engine);
    await drain(h.engine);
    expect(h.meta.count("sendPrivateReply")).toBe(1);
    expect(h.meta.count("replyToComment")).toBe(1);
  });

  it("ignores non-matching comments, other posts, threaded replies and our own comments", async () => {
    h = await makeHarness();
    const acc = await seedAccount(h.engine);
    await addAutomation(h.engine, acc, "comment", { keywords: ["price"], mediaIds: ["reelA"] }, { message: { text: "₹499" } });
    await deliver(h.engine, commentPayload(acc.ig_user_id, { id: "1", text: "nice", from: "u1", media: "reelA" }));
    await deliver(h.engine, commentPayload(acc.ig_user_id, { id: "2", text: "price?", from: "u1", media: "reelB" }));
    await deliver(h.engine, commentPayload(acc.ig_user_id, { id: "3", text: "price?", from: "u1", media: "reelA", parentId: "p" }));
    await deliver(h.engine, commentPayload(acc.ig_user_id, { id: "4", text: "price", from: acc.ig_user_id, media: "reelA" }));
    await deliver(h.engine, commentPayload(acc.ig_user_id, { id: "5", text: "PRICE", from: "u2", media: "reelA" }));
    await drain(h.engine);
    expect(h.meta.count("sendPrivateReply")).toBe(1);
    expect((h.meta.calls[0]!.args as string[])[1]).toBe("5");
  });

  it("follow gate: gate message, then branch on follower status after the button tap", async () => {
    h = await makeHarness();
    const acc = await seedAccount(h.engine);
    await addAutomation(h.engine, acc, "comment", { keywords: ["guide"] }, {
      message: { text: "Here's your guide" },
      followGate: { enabled: true, gateText: "Follow me first, then tap below", buttonTitle: "I followed", notFollowingText: "Hmm, not seeing the follow yet" },
    });
    await deliver(h.engine, commentPayload(acc.ig_user_id, { id: "c1", text: "guide", from: "fan" }));
    await drain(h.engine);
    expect((h.meta.calls.at(-1)!.args[2] as { text: string }).text).toBe("Follow me first, then tap below");

    const tap = (mid: string) => messagingPayload(acc.ig_user_id, { sender: { id: "fan" }, postback: { mid, payload: FOLLOW_CHECK_PAYLOAD, title: "I followed" } });
    await deliver(h.engine, tap("pb1"));
    await drain(h.engine);
    const last = () => h.meta.calls.at(-1)!;
    expect(last().method).toBe("sendMessage");
    expect(last().args[1]).toBe("fan");
    expect((last().args[2] as { text: string }).text).toBe("Hmm, not seeing the follow yet");

    h.meta.followers.add("fan");
    await deliver(h.engine, tap("pb2"));
    await drain(h.engine);
    expect((last().args[2] as { text: string }).text).toBe("Here's your guide");
    const [run] = await h.engine.db`select state from flow_runs`;
    expect(run!.state).toBe("completed");
  });
});

describe("DM automations", () => {
  it("keyword reply, story mention, welcome message, and inbox capture", async () => {
    h = await makeHarness();
    const acc = await seedAccount(h.engine);
    await addAutomation(h.engine, acc, "dm_keyword", { keywords: ["menu"] }, { message: { text: "Here's the menu" } });
    await addAutomation(h.engine, acc, "story_mention", { mode: "any" }, { message: { text: "Thanks for the shoutout!" } });
    await addAutomation(h.engine, acc, "welcome", { mode: "any" }, { message: { text: "Welcome!" } });

    await deliver(h.engine, messagingPayload(acc.ig_user_id, { sender: { id: "a" }, message: { mid: "m1", text: "hello there" } }));
    await deliver(h.engine, messagingPayload(acc.ig_user_id, { sender: { id: "b" }, message: { mid: "m2", text: "send MENU" } }));
    await deliver(h.engine, messagingPayload(acc.ig_user_id, { sender: { id: "c" }, message: { mid: "m3", attachments: [{ type: "story_mention", payload: { url: "https://cdn/x" } }] } }));
    await drain(h.engine);

    const sent = h.meta.calls.filter((c) => c.method === "sendMessage").map((c) => [c.args[1], (c.args[2] as { text: string }).text]);
    expect(sent.sort()).toEqual([["a", "Welcome!"], ["b", "Here's the menu"], ["c", "Thanks for the shoutout!"]]);
    const inbound = await h.engine.db`select kind, body from messages where direction = 'in' order by body`;
    expect(inbound.map((m) => m.kind).sort()).toEqual(["dm", "dm", "story_mention"]);
    const [c] = await h.engine.db`select unread_count, last_inbound_at from contacts where igsid = 'b'`;
    expect(c!.unread_count).toBe(1);
    expect(c!.last_inbound_at).not.toBeNull();
  });

  it("bot pause stops automations for that contact", async () => {
    h = await makeHarness();
    const acc = await seedAccount(h.engine);
    await addAutomation(h.engine, acc, "dm_keyword", { keywords: ["hi"] }, { message: { text: "auto" } });
    await deliver(h.engine, messagingPayload(acc.ig_user_id, { sender: { id: "a" }, message: { mid: "m1", text: "hi" } }));
    await drain(h.engine);
    await h.engine.db`update contacts set bot_paused = true`;
    await deliver(h.engine, messagingPayload(acc.ig_user_id, { sender: { id: "a" }, message: { mid: "m2", text: "hi" } }));
    await drain(h.engine);
    expect(h.meta.count("sendMessage")).toBe(1);
  });
});

describe("send worker guarantees", () => {
  it("checks the 24h window at send time and dead-letters closed windows", async () => {
    h = await makeHarness({ workers: false });
    const acc = await seedAccount(h.engine);
    const [c] = await h.engine.db`insert into contacts (workspace_id, ig_account_id, igsid, last_inbound_at)
      values (${acc.workspace_id}, ${acc.id}, 'old', now() - interval '25 hours') returning id`;
    const [m] = await h.engine.db`insert into messages (workspace_id, ig_account_id, contact_id, direction, body, payload, status, sent_by)
      values (${acc.workspace_id}, ${acc.id}, ${c!.id}, 'out', 'late', ${h.engine.db.json({ message: { text: "late" } })}, 'queued', 'bot') returning id`;
    expect(await performSend(h.engine, m!.id)).toEqual({ status: "skipped", reason: "window_closed" });
    const [dl] = await h.engine.db`select reason from dead_letters`;
    expect(dl!.reason).toBe("window_closed");
    expect(h.meta.calls).toHaveLength(0);
  });

  it("auth errors mark the account needs_reconnect; transient errors retry", async () => {
    h = await makeHarness();
    const acc = await seedAccount(h.engine);
    await addAutomation(h.engine, acc, "comment", { mode: "any" }, { message: { text: "hi" } });
    h.meta.failNext.push(new MetaApiError(503, { message: "temporarily unavailable" }));
    await deliver(h.engine, commentPayload(acc.ig_user_id, { id: "c1", text: "x", from: "u1" }));
    await drain(h.engine);
    expect(h.meta.count("sendPrivateReply")).toBe(1);

    h.meta.failNext.push(new MetaApiError(400, { message: "token expired", code: 190 }));
    await deliver(h.engine, commentPayload(acc.ig_user_id, { id: "c2", text: "x", from: "u2" }));
    await drain(h.engine);
    const [a] = await h.engine.db`select status from ig_accounts`;
    expect(a!.status).toBe("needs_reconnect");
    const dls = await h.engine.db`select reason from dead_letters`;
    expect(dls.map((d) => d.reason)).toEqual(["auth_error"]);
  });

  it("rate limiter queues sends instead of dropping them", async () => {
    // 3600/h = 1 per second, burst 300 → floor(3600/12)=300; use a tiny budget instead.
    h = await makeHarness({ sendsPerHour: 7200 });
    h.engine.limiter = new (h.engine.limiter.constructor as typeof import("@marqbee/core").AccountRateLimiter)(h.engine.redis, {
      perHour: 7200,
      burst: 2,
      prefix: `${h.engine.queues.events.opts.prefix}:rl`,
    });
    const acc = await seedAccount(h.engine);
    await addAutomation(h.engine, acc, "comment", { mode: "any" }, { message: { text: "hi" } });
    const t = Date.now();
    for (let i = 0; i < 6; i++) await deliver(h.engine, commentPayload(acc.ig_user_id, { id: `c${i}`, text: "x", from: `u${i}` }));
    await drain(h.engine, 30_000);
    expect(h.meta.count("sendPrivateReply")).toBe(6);
    // 2 burst + 4 at 2/s → at least ~1.5s.
    expect(Date.now() - t).toBeGreaterThan(1400);
  });
});
