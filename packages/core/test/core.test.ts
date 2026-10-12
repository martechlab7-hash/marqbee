import { describe, expect, it } from "vitest";
import {
  verifyMetaSignature,
  signMetaPayload,
  normalizeWebhook,
  matchKeyword,
  pickVariant,
  renderTemplate,
  checkSendWindow,
  TokenVault,
  LocalKeyWrapper,
  classifyMetaError,
  toMetaMessage,
  parseSignedRequest,
  makeSignedRequest,
  compileAutomation,
  validateGraph,
  runFlow,
  routeReply,
  FOLLOW_CHECK_PAYLOAD,
  type FlowPort,
} from "../src/index.js";
import { randomBytes } from "node:crypto";

describe("signature", () => {
  it("accepts a valid X-Hub-Signature-256 and rejects tampering", () => {
    const body = JSON.stringify({ object: "instagram", entry: [] });
    const sig = signMetaPayload(body, "secret");
    expect(verifyMetaSignature(body, sig, "secret")).toBe(true);
    expect(verifyMetaSignature(body + " ", sig, "secret")).toBe(false);
    expect(verifyMetaSignature(body, sig, "other")).toBe(false);
    expect(verifyMetaSignature(body, undefined, "secret")).toBe(false);
    expect(verifyMetaSignature(body, "sha256=zz", "secret")).toBe(false);
  });
});

describe("normalizeWebhook", () => {
  it("extracts comments, story replies, mentions, postbacks with dedupe keys", () => {
    const events = normalizeWebhook({
      object: "instagram",
      entry: [
        {
          id: "IGBIZ",
          time: 1760000000,
          changes: [
            { field: "comments", value: { id: "c1", text: "LINK please", from: { id: "u1", username: "asha" }, media: { id: "m1", media_product_type: "REELS" } } },
            { field: "mentions", value: { media_id: "x" } },
          ],
          messaging: [
            { sender: { id: "u2" }, recipient: { id: "IGBIZ" }, timestamp: 1760000000000, message: { mid: "mid1", text: "🔥", reply_to: { story: { id: "s1", url: "https://x" } } } },
            { sender: { id: "u3" }, recipient: { id: "IGBIZ" }, timestamp: 1760000000000, message: { mid: "mid2", attachments: [{ type: "story_mention", payload: { url: "https://y" } }] } },
            { sender: { id: "u4" }, recipient: { id: "IGBIZ" }, timestamp: 1760000000000, postback: { mid: "mid3", payload: "P", title: "T" } },
          ],
        },
      ],
    });
    expect(events.map((e) => e.dedupeKey)).toEqual(["comment:c1", "message:mid1", "message:mid2", "postback:mid3"]);
    const [c, sr, sm] = events;
    expect(c).toMatchObject({ kind: "comment", igUserId: "IGBIZ", fromId: "u1", mediaId: "m1", isLive: false });
    expect(sr).toMatchObject({ kind: "message", storyReply: { storyId: "s1" } });
    expect(sm).toMatchObject({ kind: "message", storyMention: { url: "https://y" } });
  });

  it("ignores non-instagram objects and malformed payloads", () => {
    expect(normalizeWebhook({ object: "page", entry: [] })).toEqual([]);
    expect(normalizeWebhook("nope")).toEqual([]);
  });
});

describe("matching", () => {
  it("matches whole words, case/emoji insensitive", () => {
    const t = { mode: "contains" as const, keywords: ["link", "price"] };
    expect(matchKeyword("LINK 🔥🔥", t)).toBe("link");
    expect(matchKeyword("send me the link!", t)).toBe("link");
    expect(matchKeyword("I linked it", t)).toBeNull();
    expect(matchKeyword("Price?", t)).toBe("price");
    expect(matchKeyword("whatever", { mode: "any", keywords: [] })).toBe("*");
    expect(matchKeyword("link please", { mode: "exact", keywords: ["link"] })).toBeNull();
    expect(matchKeyword(" Link ", { mode: "exact", keywords: ["link"] })).toBe("link");
  });
  it("supports Hindi/Devanagari keywords", () => {
    expect(matchKeyword("लिंक भेजो", { mode: "contains", keywords: ["लिंक"] })).toBe("लिंक");
  });
  it("rotates variants deterministically", () => {
    const v = ["a", "b", "c"];
    expect(pickVariant(v, "c1")).toBe(pickVariant(v, "c1"));
    const seen = new Set(Array.from({ length: 50 }, (_, i) => pickVariant(v, `c${i}`)));
    expect(seen.size).toBe(3);
    expect(pickVariant(["  "], "x")).toBeUndefined();
  });
  it("renders templates", () => {
    expect(renderTemplate("Hi {{username}}! {{missing}}", { username: "asha" })).toBe("Hi asha! ");
  });
});

describe("send windows", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  it("enforces 24h standard window from last inbound", () => {
    expect(checkSendWindow("standard", { now, lastInboundAt: new Date("2026-10-11T12:30:00Z") }).ok).toBe(true);
    expect(checkSendWindow("standard", { now, lastInboundAt: new Date("2026-10-11T11:00:00Z") })).toEqual({ ok: false, reason: "window_closed" });
    expect(checkSendWindow("standard", { now, lastInboundAt: null })).toEqual({ ok: false, reason: "no_inbound" });
  });
  it("allows 7d for human agent and private replies", () => {
    const d3 = new Date("2026-10-09T12:00:00Z");
    expect(checkSendWindow("human_agent", { now, lastInboundAt: d3 }).ok).toBe(true);
    expect(checkSendWindow("private_reply", { now, commentAt: d3 }).ok).toBe(true);
    expect(checkSendWindow("private_reply", { now, commentAt: new Date("2026-10-01T00:00:00Z") }).ok).toBe(false);
  });
});

describe("token vault", () => {
  it("round-trips and never stores plaintext", async () => {
    const vault = new TokenVault(new LocalKeyWrapper(randomBytes(32).toString("base64")));
    const enc = await vault.encrypt("IGQVJ-secret-token");
    expect(enc).not.toContain("IGQVJ");
    expect(await vault.decrypt(enc)).toBe("IGQVJ-secret-token");
  });
  it("fails on tampered ciphertext", async () => {
    const vault = new TokenVault(new LocalKeyWrapper(randomBytes(32).toString("base64")));
    const env = JSON.parse(await vault.encrypt("t"));
    env.c = env.c.slice(0, -4) + "AAAA";
    await expect(vault.decrypt(JSON.stringify(env))).rejects.toThrow();
  });
});

describe("meta errors and payloads", () => {
  it("classifies errors", () => {
    expect(classifyMetaError(400, { code: 80002 })).toBe("rate_limited");
    expect(classifyMetaError(400, { code: 190 })).toBe("auth");
    expect(classifyMetaError(400, { code: 10, error_subcode: 2534022 })).toBe("permanent");
    expect(classifyMetaError(503, {})).toBe("transient");
    expect(classifyMetaError(0, { message: "network" })).toBe("transient");
  });
  it("builds a button template when buttons are present", () => {
    const m = toMetaMessage({ text: "Here", buttons: [{ type: "url", title: "Open", url: "https://a" }] });
    expect(m).toMatchObject({ attachment: { payload: { template_type: "button", buttons: [{ type: "web_url" }] } } });
    expect(toMetaMessage({ text: "hi", quickReplies: [{ title: "Yes", payload: "Y" }] })).toMatchObject({ text: "hi", quick_replies: [{ content_type: "text" }] });
  });
  it("verifies signed requests", () => {
    const sr = makeSignedRequest({ user_id: "123" }, "s");
    expect(parseSignedRequest(sr, "s")?.user_id).toBe("123");
    expect(parseSignedRequest(sr, "wrong")).toBeNull();
  });
});

describe("flow engine", () => {
  function port(opts: { follower?: boolean } = {}) {
    const log: string[] = [];
    const p: FlowPort = {
      enqueueSend: async (s) => void log.push(`send:${s.nodeId}:${s.message.text}`),
      enqueuePublicReply: async (s) => void log.push(`public:${s.text}`),
      addTag: async (t) => void log.push(`tag:${t}`),
      removeTag: async (t) => void log.push(`untag:${t}`),
      isFollower: async () => opts.follower ?? false,
      hasTag: async () => false,
    };
    return { p, log };
  }

  it("runs a simple comment automation", async () => {
    const g = compileAutomation("comment", { publicReplies: ["Sent! 📩"], message: { text: "Hey {{username}}, here's the link" }, tags: ["lead"] });
    expect(validateGraph(g)).toEqual([]);
    const { p, log } = port();
    const out = await runFlow(g, g.start, { runId: "r1", vars: { username: "asha" } }, p);
    expect(out).toEqual({ status: "completed" });
    expect(log).toEqual(["tag:lead", "public:Sent! 📩", "send:deliver:Hey asha, here's the link"]);
  });

  it("follow gate parks for input, then branches on follower status", async () => {
    const g = compileAutomation("comment", {
      message: { text: "Link: x" },
      followGate: { enabled: true, gateText: "Follow me first", buttonTitle: "Done", notFollowingText: "Not yet!" },
    });
    expect(validateGraph(g)).toEqual([]);
    const a = port();
    const first = await runFlow(g, g.start, { runId: "r", vars: {} }, a.p);
    expect(first).toEqual({ status: "awaiting_input", node: "await_follow" });
    expect(a.log).toEqual(["send:gate:Follow me first"]);

    const next = routeReply(g, "await_follow", { payload: FOLLOW_CHECK_PAYLOAD })!;
    const notYet = await runFlow(g, next, { runId: "r", vars: {} }, a.p);
    expect(notYet).toEqual({ status: "awaiting_input", node: "await_follow" });
    expect(a.log.at(-1)).toBe("send:not_following:Not yet!");

    const b = port({ follower: true });
    expect(await runFlow(g, next, { runId: "r", vars: {} }, b.p)).toEqual({ status: "completed" });
    expect(b.log).toEqual(["send:deliver:Link: x"]);
    expect(routeReply(g, "await_follow", { text: "hello" })).toBeNull();
  });

  it("rejects waits beyond the window and dangling edges", () => {
    expect(
      validateGraph({ start: "a", nodes: { a: { id: "a", type: "wait", durationMs: 25 * 3600_000, next: "zz" } } }),
    ).toHaveLength(2);
  });
});
