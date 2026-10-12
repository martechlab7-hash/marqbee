import postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
export type Db = Sql | Tx;

export function createDb(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    // Transaction-mode poolers (Neon "-pooler", pgbouncer) don't support prepared statements.
    prepare: !/-pooler\.|pgbouncer=true/.test(url),
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
 * Two connections: the service role (schema owner — ingest, workers, migrations)
 * and the RLS-restricted app role (dashboard API).
 *  - Explicit: DATABASE_SERVICE_URL + DATABASE_URL (local, Render).
 *  - Vercel + Neon: the integration sets DATABASE_URL to the owner; the app role
 *    is derived from it as marqbee_app / DATABASE_APP_PASSWORD (or DATABASE_APP_URL).
 */
export function resolveDatabaseUrls(env: NodeJS.ProcessEnv): { service?: string; app?: string; migrate?: string } {
  if (env.DATABASE_SERVICE_URL) {
    return { service: env.DATABASE_SERVICE_URL, app: env.DATABASE_APP_URL || env.DATABASE_URL, migrate: env.DATABASE_SERVICE_URL };
  }
  if (env.DATABASE_URL && (env.DATABASE_APP_URL || env.DATABASE_APP_PASSWORD)) {
    let app = env.DATABASE_APP_URL;
    if (!app) {
      const u = new URL(env.DATABASE_URL);
      u.username = "marqbee_app";
      u.password = encodeURIComponent(env.DATABASE_APP_PASSWORD!);
      app = u.toString();
    }
    return { service: env.DATABASE_URL, app, migrate: env.DATABASE_URL_UNPOOLED || env.DATABASE_URL };
  }
  return {};
}

