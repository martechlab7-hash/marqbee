import type { OutboundMessage } from "../meta/client.js";

/**
 * Flow graph model. MVP automations compile into these graphs; the v2 visual
 * builder edits them directly. Published versions are immutable and every
 * run pins the version it started on.
 */
export type Condition = { kind: "is_follower" } | { kind: "has_tag"; tag: string };

export type FlowNode =
  | { id: string; type: "send_message"; message: OutboundMessage; next?: string }
  | { id: string; type: "public_reply"; variants: string[]; next?: string }
  | { id: string; type: "condition"; condition: Condition; yes?: string; no?: string }
  | { id: string; type: "add_tag"; tag: string; next?: string }
  | { id: string; type: "remove_tag"; tag: string; next?: string }
  | { id: string; type: "wait"; durationMs: number; next?: string }
  | { id: string; type: "wait_for_reply"; routes: { payload: string; next: string }[]; anyTextNext?: string }
  | { id: string; type: "end" };

export interface FlowGraph {
  start: string;
  nodes: Record<string, FlowNode>;
}

export type TriggerKind = "comment" | "dm_keyword" | "story_reply" | "story_mention" | "welcome";

export interface AutomationConfig {
  /** Public comment replies, rotated so they look human. Comment triggers only. */
  publicReplies?: string[];
  message: OutboundMessage;
  followGate?: {
    enabled: boolean;
    gateText: string;
    buttonTitle: string;
    notFollowingText: string;
  };
  tags?: string[];
}

export interface TriggerConfig {
  /** Empty = all posts/reels. */
  mediaIds?: string[];
  mode: "any" | "contains" | "exact";
  keywords: string[];
  /** Skip replies to replies (threaded comments) to avoid bot-on-bot loops. */
  ignoreReplies?: boolean;
}

export const MAX_WAIT_MS = 23 * 60 * 60 * 1000;
