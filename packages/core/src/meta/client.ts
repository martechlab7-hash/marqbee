import { MetaApiError, type MetaErrorBody } from "./errors.js";

/**
 * The single abstraction over Meta's Instagram API (Instagram Login variant).
 * Every outbound call goes through here, and in production only the send
 * worker holds a client — so rate limiting, the window check and retries
 * live in one place. The API version is pinned via config.
 */

export type OutboundButton =
  | { type: "url"; title: string; url: string }
  | { type: "postback"; title: string; payload: string };

export interface OutboundMessage {
  text: string;
  buttons?: OutboundButton[];
  quickReplies?: { title: string; payload: string }[];
}

export interface IgProfile {
  id: string;
  username?: string;
  name?: string;
  isFollower?: boolean;
}

export interface IgMe {
  igUserId: string;
  username: string;
  accountType?: string;
  profilePictureUrl?: string;
  name?: string;
}

export interface IgComment {
  id: string;
  text: string;
  timestamp: string;
  fromId?: string;
  fromUsername?: string;
  mediaId: string;
}

export interface IgMedia {
  id: string;
  caption?: string;
  mediaType?: string;
  mediaProductType?: string;
  thumbnailUrl?: string;
  permalink?: string;
  timestamp?: string;
}

export interface MetaClient {
  sendPrivateReply(token: string, igUserId: string, commentId: string, msg: OutboundMessage): Promise<{ messageId: string }>;
  replyToComment(token: string, commentId: string, text: string): Promise<{ id: string }>;
  sendMessage(
    token: string,
    igUserId: string,
    recipientId: string,
    msg: OutboundMessage,
    opts?: { humanAgent?: boolean },
  ): Promise<{ messageId: string }>;
  getProfile(token: string, igsid: string): Promise<IgProfile>;
  getMe(token: string): Promise<IgMe>;
  subscribeWebhooks(token: string, fields: string[]): Promise<void>;
  listRecentComments(token: string, sinceMs: number): Promise<IgComment[]>;
  listMedia(token: string): Promise<IgMedia[]>;
}

export function toMetaMessage(msg: OutboundMessage): Record<string, unknown> {
  if (msg.buttons?.length) {
    return {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: msg.text.slice(0, 640),
          buttons: msg.buttons.slice(0, 3).map((b) =>
            b.type === "url"
              ? { type: "web_url", url: b.url, title: b.title.slice(0, 20) }
              : { type: "postback", payload: b.payload, title: b.title.slice(0, 20) },
          ),
        },
      },
    };
  }
  const out: Record<string, unknown> = { text: msg.text.slice(0, 1000) };
  if (msg.quickReplies?.length) {
    out.quick_replies = msg.quickReplies.slice(0, 13).map((q) => ({ content_type: "text", title: q.title.slice(0, 20), payload: q.payload }));
  }
  return out;
}

type FetchLike = typeof fetch;

export class LiveMetaClient implements MetaClient {
  private readonly base: string;
  constructor(
    graphVersion: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.base = `https://graph.instagram.com/${graphVersion}`;
  }

  private async call<T>(method: "GET" | "POST", path: string, token: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new MetaApiError(0, { message: `network error: ${(err as Error).message}` });
    }
    const json = (await res.json().catch(() => ({}))) as { error?: MetaErrorBody } & T;
    if (!res.ok || json.error) throw new MetaApiError(res.status, json.error);
    return json;
  }

  async sendPrivateReply(token: string, igUserId: string, commentId: string, msg: OutboundMessage) {
    const r = await this.call<{ message_id: string }>("POST", `/${igUserId}/messages`, token, {
      recipient: { comment_id: commentId },
      message: toMetaMessage(msg),
    });
    return { messageId: r.message_id };
  }

  async replyToComment(token: string, commentId: string, text: string) {
    return this.call<{ id: string }>("POST", `/${commentId}/replies`, token, undefined, { message: text });
  }

  async sendMessage(token: string, igUserId: string, recipientId: string, msg: OutboundMessage, opts?: { humanAgent?: boolean }) {
    const body: Record<string, unknown> = { recipient: { id: recipientId }, message: toMetaMessage(msg) };
    if (opts?.humanAgent) Object.assign(body, { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
    const r = await this.call<{ message_id: string }>("POST", `/${igUserId}/messages`, token, body);
    return { messageId: r.message_id };
  }

  async getProfile(token: string, igsid: string): Promise<IgProfile> {
    const r = await this.call<{ id: string; username?: string; name?: string; is_user_follow_business?: boolean }>(
      "GET",
      `/${igsid}`,
      token,
      undefined,
      { fields: "name,username,is_user_follow_business" },
    );
    return { id: r.id, username: r.username, name: r.name, isFollower: r.is_user_follow_business };
  }

  async getMe(token: string): Promise<IgMe> {
    const r = await this.call<{ user_id: string; username: string; account_type?: string; profile_picture_url?: string; name?: string }>(
      "GET",
      "/me",
      token,
      undefined,
      { fields: "user_id,username,account_type,profile_picture_url,name" },
    );
    return { igUserId: r.user_id, username: r.username, accountType: r.account_type, profilePictureUrl: r.profile_picture_url, name: r.name };
  }

  async subscribeWebhooks(token: string, fields: string[]) {
    await this.call("POST", "/me/subscribed_apps", token, undefined, { subscribed_fields: fields.join(",") });
  }

  async listMedia(token: string): Promise<IgMedia[]> {
    const r = await this.call<{
      data: { id: string; caption?: string; media_type?: string; media_product_type?: string; thumbnail_url?: string; media_url?: string; permalink?: string; timestamp?: string }[];
    }>("GET", "/me/media", token, undefined, {
      fields: "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp",
      limit: "24",
    });
    return r.data.map((m) => ({
      id: m.id,
      caption: m.caption,
      mediaType: m.media_type,
      mediaProductType: m.media_product_type,
      thumbnailUrl: m.thumbnail_url ?? (m.media_type === "VIDEO" ? undefined : m.media_url),
      permalink: m.permalink,
      timestamp: m.timestamp,
    }));
  }

  async listRecentComments(token: string, sinceMs: number): Promise<IgComment[]> {
    const media = await this.call<{ data: { id: string; timestamp: string }[] }>("GET", "/me/media", token, undefined, {
      fields: "id,timestamp",
      limit: "10",
    });
    const out: IgComment[] = [];
    for (const m of media.data) {
      const comments = await this.call<{ data: { id: string; text?: string; timestamp: string; username?: string; from?: { id: string; username?: string } }[] }>(
        "GET",
        `/${m.id}/comments`,
        token,
        undefined,
        { fields: "id,text,timestamp,username,from", limit: "50" },
      );
      for (const c of comments.data) {
        if (Date.parse(c.timestamp) < sinceMs) continue;
        out.push({ id: c.id, text: c.text ?? "", timestamp: c.timestamp, fromId: c.from?.id, fromUsername: c.from?.username ?? c.username, mediaId: m.id });
      }
    }
    return out;
  }
}

/**
 * Records every call instead of hitting Meta. Used in tests, local dev
 * (META_CLIENT=fake) and the viral-post load test.
 */
export class FakeMetaClient implements MetaClient {
  calls: { method: string; args: unknown[] }[] = [];
  followers = new Set<string>();
  failNext: MetaApiError[] = [];
  latencyMs = 0;
  private seq = 0;

  private async record(method: string, args: unknown[]) {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const err = this.failNext.shift();
    if (err) throw err;
    this.calls.push({ method, args });
    return `fake_${method}_${++this.seq}_${Math.random().toString(36).slice(2, 10)}`;
  }
  async sendPrivateReply(_t: string, igUserId: string, commentId: string, msg: OutboundMessage) {
    return { messageId: await this.record("sendPrivateReply", [igUserId, commentId, msg]) };
  }
  async replyToComment(_t: string, commentId: string, text: string) {
    return { id: await this.record("replyToComment", [commentId, text]) };
  }
  async sendMessage(_t: string, igUserId: string, recipientId: string, msg: OutboundMessage, opts?: { humanAgent?: boolean }) {
    return { messageId: await this.record("sendMessage", [igUserId, recipientId, msg, opts]) };
  }
  async getProfile(_t: string, igsid: string): Promise<IgProfile> {
    return { id: igsid, username: `user_${igsid}`, isFollower: this.followers.has(igsid) };
  }
  async getMe(token: string): Promise<IgMe> {
    return { igUserId: `ig_${token.slice(-6)}`, username: `creator_${token.slice(-4)}`, accountType: "CREATOR" };
  }
  async subscribeWebhooks() {}
  async listRecentComments(): Promise<IgComment[]> {
    return [];
  }
  async listMedia(): Promise<IgMedia[]> {
    const day = 86_400_000;
    return [
      { id: "fake_reel_1", caption: "3-minute masala chai recipe ☕ Comment CHAI for the full recipe", mediaProductType: "REELS", timestamp: new Date(Date.now() - day).toISOString() },
      { id: "fake_reel_2", caption: "My Diwali gifting guide 🪔 Comment GUIDE", mediaProductType: "REELS", timestamp: new Date(Date.now() - 3 * day).toISOString() },
      { id: "fake_post_3", caption: "New drop is live! Comment LINK to shop", mediaProductType: "FEED", timestamp: new Date(Date.now() - 6 * day).toISOString() },
    ];
  }
  count(method: string) {
    return this.calls.filter((c) => c.method === method).length;
  }
}
