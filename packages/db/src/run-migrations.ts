import { createDb, migrate, pgRoleName, resolveDatabaseUrls } from "./index.js";

/** Runs migrations as the schema owner and ensures the RLS app role exists with its grants. */
export async function runMigrations(env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = console.log): Promise<string[]> {
  const urls = resolveDatabaseUrls(env);
  const serviceUrl = urls.migrate;
  if (!serviceUrl) {
    throw new Error("Set DATABASE_SERVICE_URL (+ DATABASE_URL for the app role), or POSTGRES_URL/DATABASE_URL + DATABASE_APP_PASSWORD (Supabase)");
  }
  const sql = createDb(serviceUrl, { max: 1 });
  try {
    const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

    // Create the RLS-restricted app role from DATABASE_URL if it doesn't exist yet,
    // so a managed database needs no manual setup beyond its owner credentials.
    const appUrl = urls.app ? new URL(urls.app) : null;
    const serviceUser = pgRoleName(new URL(serviceUrl).username);
    const appRole = appUrl ? pgRoleName(appUrl.username) : null;
    if (appUrl && appRole && appRole !== serviceUser) {
      const role = appRole;
      const [exists] = await sql`select 1 from pg_roles where rolname = ${role}`;
      if (!exists) {
        log(`creating app role ${role}`);
        await sql.unsafe(`CREATE ROLE ${ident(role)} LOGIN PASSWORD '${decodeURIComponent(appUrl.password).replace(/'/g, "''")}'`).catch((err) => {
          throw new Error(`Could not create role ${role} (${err.message}). Create it once as an admin: CREATE ROLE ${role} LOGIN PASSWORD '...';`);
        });
      }
    }

    const applied = await migrate(sql, log);

    if (appRole && appRole !== serviceUser) {
      const role = ident(appRole);
      await sql.unsafe(`
        GRANT USAGE ON SCHEMA public TO ${role};
        GRANT SELECT, INSERT, UPDATE, DELETE ON
          workspaces, memberships, ig_accounts, contacts, flows, flow_versions, automations, flow_runs, events,
          messages, comment_replies, dead_letters, bio_pages, bio_blocks, page_views, link_clicks, tracked_links,
          conversions, saved_replies, audit_log
        TO ${role};
        GRANT SELECT (id, email, name) ON users TO ${role};
        GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role};`);
    }
    log(applied.length ? `applied ${applied.length} migration(s)` : "up to date");
    return applied;
  } finally {
    await sql.end();
  }
}
