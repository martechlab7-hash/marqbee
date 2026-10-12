import type { AutomationConfig, TriggerConfig, TriggerKind } from "@marqbee/core";

export type Role = "owner" | "admin" | "agent" | "viewer";

export interface IgAccountRow {
  id: string;
  workspace_id: string;
  ig_user_id: string;
  username: string;
  name: string | null;
  profile_picture_url: string | null;
  account_type: string | null;
  access_token_enc: string;
  token_expires_at: Date | null;
  status: "active" | "needs_reconnect" | "disconnected";
  last_reconciled_at: Date | null;
}

export interface ContactRow {
  id: string;
  workspace_id: string;
  ig_account_id: string;
  igsid: string;
  username: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  source: Record<string, unknown>;
  is_follower: boolean | null;
  bot_paused: boolean;
  last_inbound_at: Date | null;
  last_message_at: Date | null;
  unread_count: number;
  created_at: Date;
}

export interface AutomationRow {
  id: string;
  workspace_id: string;
  ig_account_id: string;
  name: string;
  type: TriggerKind;
  trigger: TriggerConfig;
  config: AutomationConfig;
  flow_id: string;
  status: "active" | "paused";
  priority: number;
}

export interface FlowRunRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  automation_id: string | null;
  flow_version_id: string;
  state: "running" | "waiting" | "awaiting_input" | "completed" | "failed" | "cancelled";
  current_node: string | null;
  resume_at: Date | null;
  context: { commentId?: string; commentAt?: string; mediaId?: string; keyword?: string; live?: boolean; privateReplyUsed?: boolean; step?: number };
}

export interface MessageRow {
  id: string;
  workspace_id: string;
  ig_account_id: string;
  contact_id: string;
  direction: "in" | "out";
  kind: "dm" | "private_reply" | "public_reply" | "story_reply" | "story_mention" | "postback";
  body: string;
  payload: Record<string, unknown>;
  meta_message_id: string | null;
  status: "received" | "queued" | "sending" | "sent" | "failed" | "skipped";
  error_code: string | null;
  error_message: string | null;
  sent_by: "bot" | "human" | "echo" | null;
  automation_id: string | null;
  flow_run_id: string | null;
  attempts: number;
  created_at: Date;
  sent_at: Date | null;
}
