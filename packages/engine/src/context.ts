import { Redis } from "ioredis";
import { pino, type Logger } from "pino";
import { AccountRateLimiter, FakeMetaClient, LiveMetaClient, LocalKeyWrapper, TokenVault, type MetaClient } from "@marqbee/core";
import { createDb, type Sql } from "@marqbee/db";
import type { Config } from "./config.js";
import { createQueues, type Queues } from "./queues.js";

/** Everything the engine needs, built once per process and passed explicitly. */
export interface Engine {
  config: Config;
  /** BYPASSRLS connection: ingest, workers. Always filter by workspace/account explicitly. */
  db: Sql;
  redis: Redis;
  queues: Queues;
  meta: MetaClient;
  vault: TokenVault;
  limiter: AccountRateLimiter;
  log: Logger;
  close(): Promise<void>;
}

export function createEngine(config: Config, overrides: Partial<Pick<Engine, "meta" | "log">> & { prefix?: string } = {}): Engine {
  const db = createDb(config.databaseServiceUrl, { max: 20 });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const prefix = overrides.prefix ?? "mqb";
  const queues = createQueues(redis, prefix);
  const log =
    overrides.log ??
    pino({
      level: process.env.LOG_LEVEL || "info",
      // Never log tokens, even by accident.
      redact: ["*.access_token", "*.accessToken", "*.access_token_enc", "*.token", "req.headers.authorization", "req.headers.cookie"],
    });
  return {
    config,
    db,
    redis,
    queues,
    meta: overrides.meta ?? (config.metaClient === "fake" ? new FakeMetaClient() : new LiveMetaClient(config.metaGraphVersion)),
    vault: new TokenVault(new LocalKeyWrapper(config.tokenEncryptionKey)),
    limiter: new AccountRateLimiter(redis, { perHour: config.sendsPerHour, prefix: `${prefix}:rl` }),
    log,
    async close() {
      await Promise.all(Object.values(queues).map((q) => q.close()));
      await db.end({ timeout: 5 });
      redis.disconnect();
    },
  };
}
