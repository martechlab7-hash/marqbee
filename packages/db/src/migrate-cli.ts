import { createDb, migrate } from "./index.js";

const serviceUrl = process.env.DATABASE_SERVICE_URL;
if (!serviceUrl) {
  console.error("DATABASE_SERVICE_URL is required");
  process.exit(1);
}
const sql = createDb(serviceUrl, { max: 1 });
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

// Create the RLS-restricted app role from DATABASE_URL if it doesn't exist yet,
// so a managed database needs no manual setup beyond its owner credentials.
const appUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const serviceUser = new URL(serviceUrl).username;
if (appUrl && appUrl.username && appUrl.username !== serviceUser) {
  const role = decodeURIComponent(appUrl.username);
  const [exists] = await sql`select 1 from pg_roles where rolname = ${role}`;
  if (!exists) {
    console.log(`creating app role ${role}`);
    await sql.unsafe(`CREATE ROLE ${ident(role)} LOGIN PASSWORD '${decodeURIComponent(appUrl.password).replace(/'/g, "''")}'`).catch((err) => {
      console.error(`Could not create role ${role} (${err.message}). Create it once as an admin: CREATE ROLE ${role} LOGIN PASSWORD '...';`);
      process.exit(1);
    });
  }
}

const applied = await migrate(sql, console.log);

if (appUrl && appUrl.username !== serviceUser) {
  const role = ident(decodeURIComponent(appUrl.username));
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
console.log(applied.length ? `applied ${applied.length} migration(s)` : "up to date");
await sql.end();
