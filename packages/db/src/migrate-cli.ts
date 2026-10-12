import { runMigrations } from "./run-migrations.js";

try {
  await runMigrations();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
