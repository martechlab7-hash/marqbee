-- Managed Postgres (Render, Neon, Supabase, RDS) has no superuser, so the
-- service role can't be granted BYPASSRLS. Instead, the role that runs
-- migrations (the schema owner, used by ingest and workers) gets an explicit
-- allow-all policy. The app role still only matches tenant_isolation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspaces', 'ig_accounts', 'contacts', 'flows', 'flow_versions', 'automations', 'flow_runs', 'events',
    'messages', 'comment_replies', 'dead_letters', 'bio_pages', 'bio_blocks', 'page_views',
    'link_clicks', 'tracked_links', 'conversions', 'saved_replies', 'audit_log', 'memberships'
  ] LOOP
    EXECUTE format('CREATE POLICY service_access ON %I AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
