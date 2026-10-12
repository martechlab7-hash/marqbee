import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "./index.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function migrate(sql: Sql, log: (m: string) => void = () => {}): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  // Serialise concurrent migrators (e.g. two deploys starting at once).
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(727274)`;
    const done = new Set((await tx<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      log(`applying ${f}`);
      await tx.unsafe(await readFile(join(MIGRATIONS_DIR, f), "utf8"));
      await tx`insert into schema_migrations (name) values (${f})`;
      applied.push(f);
    }
    return applied;
  }) as Promise<string[]>;
}
