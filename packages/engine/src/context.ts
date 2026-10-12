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
    meta: overrides.meta ?? (config.metaClient === "fake" ? new SharedFakeMetaClient(redis, prefix) : new LiveMetaClient(config.metaGraphVersion)),
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

/**
 * Dev-mode fake whose outbox and follower list live in Redis, so the API
 * (which simulates webhooks) and the worker (which sends) see the same state.
 */
export class SharedFakeMetaClient extends FakeMetaClient {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {
    super();
    const record = async (method: string, args: unknown[]) => {
      await this.redis.lpush(`${this.prefix}:dev:outbox`, JSON.stringify({ method, args, at: new Date().toISOString() }));
      await this.redis.ltrim(`${this.prefix}:dev:outbox`, 0, 99);
    };
    for (const m of ["sendPrivateReply", "replyToComment", "sendMessage"] as const) {
      const orig = this[m].bind(this) as (...a: unknown[]) => Promise<unknown>;
      (this as unknown as Record<string, unknown>)[m] = async (...a: unknown[]) => {
        const r = await orig(...a);
        await record(m, a.slice(1));
        return r;
      };
    }
  }
  async setFollower(igsid: string, follows: boolean) {
    if (follows) await this.redis.sadd(`${this.prefix}:dev:followers`, igsid);
    else await this.redis.srem(`${this.prefix}:dev:followers`, igsid);
  }
  override async getProfile(_t: string, igsid: string) {
    return { id: igsid, username: undefined, isFollower: (await this.redis.sismember(`${this.prefix}:dev:followers`, igsid)) === 1 };
  }
  async recentCalls(): Promise<{ method: string; args: unknown[]; at: string }[]> {
    return (await this.redis.lrange(`${this.prefix}:dev:outbox`, 0, 49)).map((x) => JSON.parse(x));
  }
}
