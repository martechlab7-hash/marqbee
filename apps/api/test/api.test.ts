import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, withTenant, type Sql } from "@marqbee/db";
import { makeSignedRequest, signMetaPayload } from "@marqbee/core";
import { buildApp } from "../src/app.js";
// Shared integration harness (test DB + isolated Redis prefix + fake Meta client).
import { drain, makeHarness, resetDb, TEST_DB_APP, type Harness } from "../../../packages/engine/test/helpers.js";

let h: Harness;
let appDb: Sql;
let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  h = await makeHarness();
  appDb = createDb(TEST_DB_APP, { max: 5 });
  app = await buildApp({ engine: h.engine, appDb }, { logger: false });
});
afterEach(async () => {
  await app.close();
  await appDb.end();
  await h.close();
});

async function signup(email: string) {
  const r = await app.inject({ method: "POST", url: "/auth/signup", payload: { email, password: "correct-horse-battery", name: email.split("@")[0], workspaceName: `${email.split("@")[0]} studio` } });
  expect(r.statusCode).toBe(200);
  const cookie = r.cookies.find((c) => c.name === "mqb_session")!;
  return { cookie: `mqb_session=${cookie.value}` };
}

const api = (cookie: string) => ({
  get: (url: string) => app.inject({ method: "GET", url, headers: { cookie } }),
  post: (url: string, payload?: unknown) => app.inject({ method: "POST", url, payload: payload as object, headers: { cookie } }),
  put: (url: string, payload?: unknown) => app.inject({ method: "PUT", url, payload: payload as object, headers: { cookie } }),
  patch: (url: string, payload?: unknown) => app.inject({ method: "PATCH", url, payload: payload as object, headers: { cookie } }),
});

describe("auth", () => {
  it("signup, me, logout, login; rejects wrong password and duplicates", async () => {
    const { cookie } = await signup("asha@example.com");
    const me = await api(cookie).get("/auth/me");
    expect(me.json()).toMatchObject({ user: { email: "asha@example.com" }, workspace: { role: "owner", plan: "free" } });
    expect((await app.inject({ method: "POST", url: "/auth/signup", payload: { email: "ASHA@example.com", password: "correct-horse-battery" } })).statusCode).toBe(409);
    await api(cookie).post("/auth/logout");
    expect((await api(cookie).get("/auth/me")).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: "asha@example.com", password: "nope-nope-nope" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: "asha@example.com", password: "correct-horse-battery" } })).statusCode).toBe(200);
  });

  it("requires auth for dashboard APIs and blocks cross-origin mutations", async () => {
    expect((await app.inject({ method: "GET", url: "/api/contacts" })).statusCode).toBe(401);
    const { cookie } = await signup("x@example.com");
    const r = await app.inject({ method: "POST", url: "/api/saved-replies", payload: { title: "a", body: "b" }, headers: { cookie, origin: "https://evil.example" } });
    expect(r.statusCode).toBe(403);
  });
});

describe("tenant isolation", () => {
  it("row-level security hides other workspaces even without a WHERE clause", async () => {
    const a = await signup("a@example.com");
    const b = await signup("b@example.com");
    const accA = (await api(a.cookie).post("/api/dev/connect-account", { username: "alpha" })).json();
    await api(b.cookie).post("/api/dev/connect-account", { username: "beta" });

    const listB = (await api(b.cookie).get("/api/accounts")).json();
    expect(listB.map((x: { username: string }) => x.username)).toEqual(["beta"]);
    // B can't read or touch A's account by id.
    expect((await api(b.cookie).get(`/api/accounts/${accA.id}/media`)).statusCode).toBe(404);
    expect((await api(b.cookie).post("/api/automations", automation(accA.id))).statusCode).toBe(400);

    // Directly at the DB layer: app role with no tenant set sees nothing.
    expect(await appDb`select * from ig_accounts`).toHaveLength(0);
    const [ws] = await h.engine.db`select workspace_id from ig_accounts where id = ${accA.id}`;
    const seen = await withTenant(appDb, ws!.workspace_id, (tx) => tx`select username from ig_accounts`);
    expect(seen.map((r) => r.username)).toEqual(["alpha"]);
    await expect(withTenant(appDb, ws!.workspace_id, (tx) => tx`insert into saved_replies (workspace_id, title, body) select id, 'x', 'y' from workspaces where id <> ${ws!.workspace_id} union all select gen_random_uuid(), 'x', 'y'`)).rejects.toThrow(/row-level security|foreign key/);
  });
});

function automation(igAccountId: string) {
  return {
    igAccountId,
    name: "Recipe link",
    type: "comment",
    trigger: { mode: "contains", keywords: ["CHAI"] },
    config: { publicReplies: ["Sent ☕", "Check DMs!"], message: { text: "Here's the recipe, {{username}}", buttons: [{ type: "url", title: "Recipe", url: "https://example.com/chai" }] }, tags: ["chai"] },
  };
}

describe("end to end via HTTP", () => {
  it("automation → signed webhook → DM → tracked click → analytics", async () => {
    const { cookie } = await signup("creator@example.com");
    const c = api(cookie);
    const acc = (await c.post("/api/dev/connect-account", { username: "chaiwala" })).json();
    const created = await c.post("/api/automations", automation(acc.id));
    expect(created.statusCode).toBe(200);

    const bad = await c.post("/api/automations", { ...automation(acc.id), config: { message: { text: "x", buttons: [{ type: "url", title: "t", url: "javascript:alert(1)" }] } } });
    expect(bad.statusCode).toBe(400);

    const [{ ig_user_id }] = (await h.engine.db`select ig_user_id from ig_accounts where id = ${acc.id}`) as unknown as [{ ig_user_id: string }];
    const body = JSON.stringify({ object: "instagram", entry: [{ id: ig_user_id, time: Math.floor(Date.now() / 1000), changes: [{ field: "comments", value: { id: "c1", text: "chai pls", from: { id: "fan1", username: "fan1" }, media: { id: "fake_reel_1" } } }] }] });
    const bad401 = await app.inject({ method: "POST", url: "/webhooks/instagram", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" } });
    expect(bad401.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/webhooks/instagram", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": signMetaPayload(body, h.engine.config.metaAppSecret) } });
    expect(ok.statusCode).toBe(200);
    await drain(h.engine);

    const sent = h.meta.calls.find((x) => x.method === "sendPrivateReply")!;
    const url = (sent.args[2] as { buttons: { url: string }[] }).buttons[0]!.url;
    const code = url.split("/r/")[1]!;
    const click = await app.inject({ method: "GET", url: `/r/${code}` });
    expect(click.statusCode).toBe(302);
    expect(click.headers.location).toBe("https://example.com/chai");

    const overview = (await c.get("/api/analytics/overview?days=7")).json();
    expect(overview.totals).toMatchObject({ dms_sent: 1, public_replies: 1, comments_triggered: 1, dm_link_clicks: 1, new_contacts: 1 });
    expect(overview.topKeywords).toEqual([{ keyword: "CHAI", comments: 1 }]);
    const list = (await c.get("/api/automations")).json();
    expect(list[0]).toMatchObject({ runs: 1, dms_sent: 1, clicks: 1 });

    const contacts = (await c.get("/api/contacts")).json();
    expect(contacts.contacts[0]).toMatchObject({ username: "fan1", tags: ["chai"], window_open: false });
    // No inbound DM yet → the standard window is closed; inbox refuses with a clear reason.
    const reply = await c.post(`/api/inbox/${contacts.contacts[0].id}/messages`, { text: "hello" });
    expect(reply.statusCode).toBe(422);

    // They DM back → window opens → human reply goes out.
    await c.post("/api/dev/simulate", { accountId: acc.id, kind: "dm", fromUsername: "fan1", text: "thanks!" });
    await drain(h.engine);
    const [contact] = await h.engine.db`select id from contacts where igsid = 'sim_fan1'`;
    const r2 = await c.post(`/api/inbox/${contact!.id}/messages`, { text: "enjoy!" });
    expect(r2.statusCode).toBe(200);
    await drain(h.engine);
    expect(h.meta.calls.at(-1)).toMatchObject({ method: "sendMessage" });
    const thread = (await c.get(`/api/inbox/${contact!.id}/messages`)).json();
    expect(thread.map((m: { direction: string; body: string }) => `${m.direction}:${m.body}`)).toEqual(["in:thanks!", "out:enjoy!"]);
  });

  it("bio page: save, public render, view + click logging with UTMs", async () => {
    const { cookie } = await signup("bio@example.com");
    const c = api(cookie);
    const page = (await c.get("/api/bio")).json();
    expect(page.slug).toBe("bio-studio");
    const saved = await c.put("/api/bio", {
      slug: "Masala Mom", title: "Masala Mom", bio: "Recipes in 60s", theme: { preset: "sunrise" }, showBadge: false, published: true,
      blocks: [
        { type: "header", data: { text: "Shop" } },
        { type: "link", data: { title: "Spice kit", url: "https://shop.example/kit", utm: { utm_source: "marqbee" } } },
      ],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().slug).toBe("masala-mom");

    const pub = (await app.inject({ method: "GET", url: "/public/bio/masala-mom" })).json();
    expect(pub.show_badge).toBe(true); // free plan always shows the badge
    expect(pub.blocks).toHaveLength(2);
    await app.inject({ method: "POST", url: "/public/bio/masala-mom/view", payload: { referrer: "instagram.com" } });
    const linkId = pub.blocks[1].id;
    const r = await app.inject({ method: "GET", url: `/b/${linkId}?utm_campaign=diwali` });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("https://shop.example/kit?utm_source=marqbee");
    const o = (await c.get("/api/analytics/overview")).json();
    expect(o.totals).toMatchObject({ bio_views: 1, bio_clicks: 1 });
    expect(o.topLinks[0]).toMatchObject({ title: "Spice kit", clicks: 1 });

    // Re-saving keeps block ids stable so click history survives edits.
    const again = await c.put("/api/bio", { ...{ slug: "masala-mom", title: "MM", bio: "", theme: { preset: "mint" }, showBadge: true, published: true }, blocks: saved.json().blocks.map((b: object) => b) });
    expect(again.json().blocks.map((b: { id: string }) => b.id)).toEqual(saved.json().blocks.map((b: { id: string }) => b.id));

    const other = await signup("other@example.com");
    expect((await api(other.cookie).put("/api/bio", { slug: "masala-mom", title: "", bio: "", theme: { preset: "paper" }, showBadge: true, published: true, blocks: [] })).statusCode).toBe(409);
  });
});

describe("meta platform endpoints", () => {
  it("webhook verify handshake", async () => {
    const ok = await app.inject({ method: "GET", url: `/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${h.engine.config.metaVerifyToken}&hub.challenge=123` });
    expect(ok.body).toBe("123");
    expect((await app.inject({ method: "GET", url: "/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1" })).statusCode).toBe(403);
  });

  it("deauthorize and data deletion callbacks", async () => {
    const { cookie } = await signup("d@example.com");
    const acc = (await api(cookie).post("/api/dev/connect-account", { username: "gone" })).json();
    const [{ ig_user_id }] = (await h.engine.db`select ig_user_id from ig_accounts where id = ${acc.id}`) as unknown as [{ ig_user_id: string }];
    const sr = makeSignedRequest({ user_id: ig_user_id }, h.engine.config.metaAppSecret);

    expect((await app.inject({ method: "POST", url: "/meta/deauthorize", payload: "signed_request=bad.sig", headers: { "content-type": "application/x-www-form-urlencoded" } })).statusCode).toBe(400);
    await app.inject({ method: "POST", url: "/meta/deauthorize", payload: `signed_request=${sr}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
    const [a] = await h.engine.db`select status, access_token_enc from ig_accounts where id = ${acc.id}`;
    expect(a).toMatchObject({ status: "disconnected", access_token_enc: "" });

    const del = await app.inject({ method: "POST", url: "/meta/data-deletion", payload: `signed_request=${sr}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
    const { confirmation_code } = del.json();
    expect(await h.engine.db`select 1 from ig_accounts where id = ${acc.id}`).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: `/meta/data-deletion/${confirmation_code}` })).json().status).toBe("completed");
  });
});
