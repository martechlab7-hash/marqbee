import postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
export type Db = Sql | Tx;

export function createDb(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
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
export * from "./types.js";
