import { z } from "zod";

/**
 * Normalises Instagram webhook payloads (Instagram API with Instagram Login)
 * into a flat list of events, each with a stable dedupe key so a redelivered
 * webhook can never trigger a second send.
 */

const Comment = z.object({
  id: z.string(),
  text: z.string().optional().default(""),
  from: z.object({ id: z.string(), username: z.string().optional() }).optional(),
  media: z.object({ id: z.string(), media_product_type: z.string().optional() }).optional(),
  parent_id: z.string().optional(),
});

const Messaging = z.object({
  sender: z.object({ id: z.string() }),
  recipient: z.object({ id: z.string() }),
  timestamp: z.number().optional(),
  message: z
    .object({
      mid: z.string(),
      text: z.string().optional(),
      is_echo: z.boolean().optional(),
      is_deleted: z.boolean().optional(),
      quick_reply: z.object({ payload: z.string() }).optional(),
      reply_to: z
        .object({ story: z.object({ id: z.string(), url: z.string().optional() }).optional(), mid: z.string().optional() })
        .optional(),
      attachments: z.array(z.object({ type: z.string(), payload: z.object({ url: z.string().optional() }).passthrough().optional() })).optional(),
    })
    .optional(),
  postback: z.object({ mid: z.string().optional(), title: z.string().optional(), payload: z.string() }).optional(),
});

const Entry = z.object({
  id: z.string(),
  time: z.number().optional(),
  changes: z.array(z.object({ field: z.string(), value: z.unknown() })).optional(),
  messaging: z.array(Messaging).optional(),
});

export const WebhookPayload = z.object({ object: z.string(), entry: z.array(Entry) });
export type WebhookPayload = z.infer<typeof WebhookPayload>;

export type NormalizedEvent =
  | {
      kind: "comment";
      dedupeKey: string;
      igUserId: string;
      commentId: string;
      text: string;
      fromId: string;
      fromUsername?: string;
      mediaId?: string;
      mediaProductType?: string;
      parentId?: string;
      isLive: boolean;
      occurredAt: Date;
    }
  | {
      kind: "message";
      dedupeKey: string;
      igUserId: string;
      senderId: string;
      recipientId: string;
      mid: string;
      text: string;
      isEcho: boolean;
      quickReplyPayload?: string;
      storyReply?: { storyId: string; url?: string };
      storyMention?: { url?: string };
      occurredAt: Date;
    }
  | {
      kind: "postback";
      dedupeKey: string;
      igUserId: string;
      senderId: string;
      payload: string;
      title?: string;
      occurredAt: Date;
    };

export function normalizeWebhook(body: unknown): NormalizedEvent[] {
  const parsed = WebhookPayload.safeParse(body);
  if (!parsed.success || parsed.data.object !== "instagram") return [];
  const out: NormalizedEvent[] = [];

  for (const entry of parsed.data.entry) {
    const entryTime = entry.time ? new Date(entry.time * (entry.time < 1e12 ? 1000 : 1)) : new Date();

    for (const change of entry.changes ?? []) {
      if (change.field !== "comments" && change.field !== "live_comments") continue;
      const c = Comment.safeParse(change.value);
      if (!c.success || !c.data.from) continue;
      out.push({
        kind: "comment",
        dedupeKey: `comment:${c.data.id}`,
        igUserId: entry.id,
        commentId: c.data.id,
        text: c.data.text,
        fromId: c.data.from.id,
        fromUsername: c.data.from.username,
        mediaId: c.data.media?.id,
        mediaProductType: c.data.media?.media_product_type,
        parentId: c.data.parent_id,
        isLive: change.field === "live_comments",
        occurredAt: entryTime,
      });
    }

    for (const m of entry.messaging ?? []) {
      const occurredAt = m.timestamp ? new Date(m.timestamp) : entryTime;
      if (m.postback) {
        out.push({
          kind: "postback",
          dedupeKey: `postback:${m.postback.mid ?? `${m.sender.id}:${m.timestamp ?? 0}:${m.postback.payload}`}`,
          igUserId: entry.id,
          senderId: m.sender.id,
          payload: m.postback.payload,
          title: m.postback.title,
          occurredAt,
        });
        continue;
      }
      if (!m.message || m.message.is_deleted) continue;
      const mention = m.message.attachments?.find((a) => a.type === "story_mention");
      const story = m.message.reply_to?.story;
      out.push({
        kind: "message",
        dedupeKey: `message:${m.message.mid}`,
        igUserId: entry.id,
        senderId: m.sender.id,
        recipientId: m.recipient.id,
        mid: m.message.mid,
        text: m.message.text ?? "",
        isEcho: m.message.is_echo === true,
        quickReplyPayload: m.message.quick_reply?.payload,
        storyReply: story ? { storyId: story.id, url: story.url } : undefined,
        storyMention: mention ? { url: mention.payload?.url } : undefined,
        occurredAt,
      });
    }
  }
  return out;
}
