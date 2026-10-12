-- Supabase exposes everything in the public schema through its Data API
-- (PostgREST/GraphQL) to the `anon` and `authenticated` roles, using keys that
-- ship in browsers. Marqbee never uses the Data API: all access goes through
-- our server with its own roles. So remove those grants entirely — otherwise
-- tables without RLS (users with password hashes, sessions) would be readable
-- with the public anon key. No-op on plain Postgres where these roles don't exist.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      -- Tables created by later migrations (run as this same owner) stay private too.
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- Defence in depth: RLS on every remaining table. The owner (no FORCE) still has
-- full access; anything else gets nothing unless a policy says otherwise.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
-- The dashboard role reads teammates' id/email/name (column grant only — never password_hash).
CREATE POLICY users_readable ON users FOR SELECT USING (true);
