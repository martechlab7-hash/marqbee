/** Meta messaging windows. Checked at send time, never at schedule time. */

export const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type SendKind = "private_reply" | "standard" | "human_agent";

export interface WindowCheck {
  ok: boolean;
  reason?: "no_inbound" | "window_closed" | "comment_too_old";
}

export function checkSendWindow(
  kind: SendKind,
  opts: { now?: Date; lastInboundAt?: Date | null; commentAt?: Date | null },
): WindowCheck {
  const now = (opts.now ?? new Date()).getTime();
  if (kind === "private_reply") {
    if (!opts.commentAt) return { ok: true };
    return now - opts.commentAt.getTime() <= PRIVATE_REPLY_WINDOW_MS ? { ok: true } : { ok: false, reason: "comment_too_old" };
  }
  if (!opts.lastInboundAt) return { ok: false, reason: "no_inbound" };
  const limit = kind === "human_agent" ? HUMAN_AGENT_WINDOW_MS : STANDARD_WINDOW_MS;
  return now - opts.lastInboundAt.getTime() <= limit ? { ok: true } : { ok: false, reason: "window_closed" };
}

export function windowExpiresAt(lastInboundAt: Date | null | undefined): Date | null {
  return lastInboundAt ? new Date(lastInboundAt.getTime() + STANDARD_WINDOW_MS) : null;
}
