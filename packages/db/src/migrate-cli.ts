import { createDb, migrate } from "./index.js";

const url = process.env.DATABASE_SERVICE_URL;
if (!url) {
  console.error("DATABASE_SERVICE_URL is required");
  process.exit(1);
}
const sql = createDb(url, { max: 1 });
const applied = await migrate(sql, console.log);
console.log(applied.length ? `applied ${applied.length} migration(s)` : "up to date");
await sql.end();
