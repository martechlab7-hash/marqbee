-- Marqbee core schema. Multi-tenant by workspace_id with row-level security.
-- The app role (dashboard API) only ever sees rows for app.workspace_id;
-- the service role (webhook ingest, workers) has BYPASSRLS.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'creator_pro', 'business', 'agency')),
  billing_customer_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  name text,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'agent', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE sessions (
  id text PRIMARY KEY, -- sha256 of the cookie token, never the token itself
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ig_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ig_user_id text NOT NULL UNIQUE,
  username text NOT NULL,
  name text,
  profile_picture_url text,
  account_type text,
  access_token_enc text NOT NULL,
  token_expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reconnect', 'disconnected')),
  last_reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ig_accounts (workspace_id);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ig_account_id uuid NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  igsid text NOT NULL,
  username text,
  name text,
  email text,
  phone text,
  tags text[] NOT NULL DEFAULT '{}',
  custom_fields jsonb NOT NULL DEFAULT '{}',
  source jsonb NOT NULL DEFAULT '{}',
  is_follower boolean,
  bot_paused boolean NOT NULL DEFAULT false,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  last_inbound_at timestamptz,
  last_message_at timestamptz,
  unread_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ig_account_id, igsid)
);
CREATE INDEX ON contacts (workspace_id, last_message_at DESC NULLS LAST);
CREATE INDEX ON contacts USING gin (tags);

CREATE TABLE flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE flow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  version int NOT NULL,
  graph jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, version)
);
ALTER TABLE flows ADD FOREIGN KEY (current_version_id) REFERENCES flow_versions(id);

-- Published versions are immutable.
CREATE FUNCTION forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME; END $$;
CREATE TRIGGER flow_versions_immutable BEFORE UPDATE ON flow_versions FOR EACH ROW EXECUTE FUNCTION forbid_update();

CREATE TABLE automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ig_account_id uuid NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('comment', 'dm_keyword', 'story_reply', 'story_mention', 'welcome')),
  trigger jsonb NOT NULL DEFAULT '{}',
  config jsonb NOT NULL DEFAULT '{}',
  flow_id uuid NOT NULL REFERENCES flows(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  priority int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON automations (ig_account_id, type) WHERE status = 'active';

CREATE TABLE flow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  automation_id uuid REFERENCES automations(id) ON DELETE SET NULL,
  flow_version_id uuid NOT NULL REFERENCES flow_versions(id),
  state text NOT NULL CHECK (state IN ('running', 'waiting', 'awaiting_input', 'completed', 'failed', 'cancelled')),
  current_node text,
  resume_at timestamptz,
  context jsonb NOT NULL DEFAULT '{}',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON flow_runs (contact_id) WHERE state IN ('waiting', 'awaiting_input');
CREATE INDEX ON flow_runs (resume_at) WHERE state = 'waiting';

-- Raw webhook bodies, stored before anything else so nothing is ever lost.
CREATE TABLE webhook_deliveries (
  id bigserial PRIMARY KEY,
  body jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id bigserial PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  ig_account_id uuid REFERENCES ig_accounts(id) ON DELETE CASCADE,
  ig_user_id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text
);
CREATE INDEX ON events (received_at) WHERE processed_at IS NULL;

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ig_account_id uuid NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  kind text NOT NULL DEFAULT 'dm' CHECK (kind IN ('dm', 'private_reply', 'public_reply', 'story_reply', 'story_mention', 'postback')),
  body text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}',
  meta_message_id text UNIQUE,
  status text NOT NULL CHECK (status IN ('received', 'queued', 'sending', 'sent', 'failed', 'skipped')),
  error_code text,
  error_message text,
  sent_by text CHECK (sent_by IN ('bot', 'human', 'echo')),
  sent_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  automation_id uuid REFERENCES automations(id) ON DELETE SET NULL,
  flow_run_id uuid REFERENCES flow_runs(id) ON DELETE SET NULL,
  -- Idempotency for bot sends: one message per (run, node, step).
  idempotency_key text UNIQUE,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX ON messages (contact_id, created_at);
CREATE INDEX ON messages (workspace_id, created_at);

-- Enforces Meta's one-private-reply-per-comment rule in our own DB.
CREATE TABLE comment_replies (
  comment_id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ig_account_id uuid NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  automation_id uuid REFERENCES automations(id) ON DELETE SET NULL,
  media_id text,
  keyword text,
  commented_at timestamptz NOT NULL,
  private_reply_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  private_reply_sent_at timestamptz,
  public_reply_id text,
  public_reply_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON comment_replies (workspace_id, created_at);

CREATE TABLE dead_letters (
  id bigserial PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  reason text NOT NULL,
  error_code text,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bio_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE,
  title text NOT NULL DEFAULT '',
  bio text NOT NULL DEFAULT '',
  avatar_url text,
  theme jsonb NOT NULL DEFAULT '{"preset":"sunrise"}',
  show_badge boolean NOT NULL DEFAULT true,
  published boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bio_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES bio_pages(id) ON DELETE CASCADE,
  position int NOT NULL,
  type text NOT NULL CHECK (type IN ('link', 'header', 'text', 'youtube', 'spotify', 'socials')),
  data jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON bio_blocks (page_id, position);

CREATE TABLE page_views (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES bio_pages(id) ON DELETE CASCADE,
  referrer text,
  utm jsonb NOT NULL DEFAULT '{}',
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON page_views (page_id, ts);

CREATE TABLE link_clicks (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id uuid REFERENCES bio_pages(id) ON DELETE CASCADE,
  block_id uuid REFERENCES bio_blocks(id) ON DELETE SET NULL,
  -- Set for tracked links sent inside DMs, so clicks join back to the contact.
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  automation_id uuid REFERENCES automations(id) ON DELETE SET NULL,
  url text NOT NULL,
  utm jsonb NOT NULL DEFAULT '{}',
  ua text,
  referrer text,
  country text,
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON link_clicks (workspace_id, ts);

-- Short tracked links used inside DMs: /r/<code> → url, attributed to a contact.
CREATE TABLE tracked_links (
  code text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url text NOT NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  automation_id uuid REFERENCES automations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversions (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('shopify', 'razorpay', 'manual')),
  external_id text,
  amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  utm jsonb NOT NULL DEFAULT '{}',
  ts timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE TABLE saved_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  diff jsonb NOT NULL DEFAULT '{}',
  ts timestamptz NOT NULL DEFAULT now()
);

-- Service-only tables (no tenant context exists yet when these are used).
CREATE TABLE oauth_states (
  state text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE data_deletion_requests (
  confirmation_code text PRIMARY KEY,
  ig_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Row-level security on every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ig_accounts', 'contacts', 'flows', 'flow_versions', 'automations', 'flow_runs', 'events',
    'messages', 'comment_replies', 'dead_letters', 'bio_pages', 'bio_blocks', 'page_views',
    'link_clicks', 'tracked_links', 'conversions', 'saved_replies', 'audit_log', 'memberships'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid) '
      'WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspaces
  USING (id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'marqbee_app') THEN
    GRANT USAGE ON SCHEMA public TO marqbee_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      workspaces, memberships, ig_accounts, contacts, flows, flow_versions, automations, flow_runs, events,
      messages, comment_replies, dead_letters, bio_pages, bio_blocks, page_views, link_clicks, tracked_links,
      conversions, saved_replies, audit_log
    TO marqbee_app;
    GRANT SELECT (id, email, name) ON users TO marqbee_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO marqbee_app;
  END IF;
END $$;
