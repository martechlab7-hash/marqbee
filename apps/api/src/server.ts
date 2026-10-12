import { createEngine, loadConfig } from "@marqbee/engine";
import { createDb } from "@marqbee/db";
import { buildApp } from "./app.js";

const config = loadConfig();
const engine = createEngine(config);
const appDb = createDb(config.databaseUrl);
const app = await buildApp({ engine, appDb });

if (config.metaClient === "fake") app.log.warn("META_CLIENT=fake — sends are recorded, not delivered to Instagram");
await app.listen({ port: config.apiPort, host: "0.0.0.0" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await appDb.end({ timeout: 5 });
    await engine.close();
    process.exit(0);
  });
}
