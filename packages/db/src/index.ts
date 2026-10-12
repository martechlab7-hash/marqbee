import postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
export type Db = Sql | Tx;

export function createDb(url: string, opts: { max?: number } = {}): Sql {
  const { url: clean, ssl, pooled } = normalizeDbUrl(url);
  return postgres(clean, {
    // Transaction-mode poolers (Supabase Supavisor :6543, pgbouncer, Neon "-pooler") don't support prepared statements.
    prepare: !pooled,
    ssl,
    max: opts.max ?? 10,
    onnotice: () => {},
    transform: { undefined: null },
    types: { bigint: postgres.BigInt },
  });
}

/**
 * Runs `fn` inside a transaction scoped to one workspace. With the app role,
 * Postgres row-level security then hides every other tenant's rows, so a
 * missing WHERE clause cannot leak data across workspaces.
 */
export async function withTenant<T>(sql: Sql, workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

export { migrate } from "./migrate.js";
export { runMigrations } from "./run-migrations.js";
export * from "./types.js";

/**
 * Provider URLs carry extra query parameters (Supabase adds `supa=…`, Prisma-style
 * `pgbouncer=true`) that postgres.js would send to the server as startup
 * parameters, which Postgres rejects. Keep only what we understand.
 */
export function normalizeDbUrl(url: string): { url: string; ssl: false | "require"; pooled: boolean } {
  const u = new URL(url);
  const sslmode = u.searchParams.get("sslmode");
  const pooled = u.port === "6543" || u.searchParams.get("pgbouncer") === "true" || /(^|[.-])pooler\./.test(u.hostname);
  const managed = /\.(supabase\.(co|com)|neon\.tech)$/.test(u.hostname);
  u.search = "";
  const ssl = sslmode === "disable" ? false : sslmode || managed ? "require" : false;
  return { url: u.toString(), ssl, pooled };
}

/**
 * Pooler usernames carry the project: Supabase Supavisor uses `role.projectref`.
 * The Postgres role itself is just `role`.
 */
export function pgRoleName(username: string): string {
  const m = decodeURIComponent(username).match(/^(.+)\.([a-z0-9]{20})$/);
  return m ? m[1]! : decodeURIComponent(username);
}

/**
 * Two connections: the service role (schema owner — ingest, workers, migrations)
 * and the RLS-restricted app role (dashboard API).
 *  - Explicit: DATABASE_SERVICE_URL + DATABASE_URL (local, Render, any Postgres).
 *  - Vercel + Supabase integration: POSTGRES_URL (pooled) / POSTGRES_URL_NON_POOLING.
 *  - Single owner URL in DATABASE_URL (Supabase pasted manually, Neon).
 * In the last two cases the app role is derived from the owner URL as
 * marqbee_app[.projectref] / DATABASE_APP_PASSWORD (or given as DATABASE_APP_URL).
 */
export function resolveDatabaseUrls(env: NodeJS.ProcessEnv): { service?: string; app?: string; migrate?: string } {
  if (env.DATABASE_SERVICE_URL) {
    return { service: env.DATABASE_SERVICE_URL, app: env.DATABASE_APP_URL || env.DATABASE_URL, migrate: env.DATABASE_SERVICE_URL };
  }
  const owner = env.POSTGRES_URL || env.DATABASE_URL;
  if (owner && (env.DATABASE_APP_URL || env.DATABASE_APP_PASSWORD)) {
    let app = env.DATABASE_APP_URL;
    if (!app) {
      const u = new URL(owner);
      const ref = decodeURIComponent(u.username).match(/\.([a-z0-9]{20})$/)?.[1];
      u.username = ref ? `marqbee_app.${ref}` : "marqbee_app";
      u.password = encodeURIComponent(env.DATABASE_APP_PASSWORD!);
      app = u.toString();
    }
    const direct = env.POSTGRES_URL ? env.POSTGRES_URL_NON_POOLING : env.DATABASE_URL_UNPOOLED;
    return { service: owner, app, migrate: direct || owner };
  }
  return {};
}

