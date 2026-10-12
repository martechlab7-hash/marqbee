import type { Redis } from "ioredis";

/**
 * Per-account token bucket in Redis. Meta allows 750 private-reply calls/hour
 * per professional account; we run at ~80% of that so retries and manual
 * inbox replies always have headroom.
 */
export const META_HOURLY_LIMIT = 750;
export const DEFAULT_HOURLY_BUDGET = Math.floor(META_HOURLY_LIMIT * 0.8);

const LUA = `
local key = KEYS[1]
local pauseKey = KEYS[2]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local pausedUntil = tonumber(redis.call('GET', pauseKey) or '0')
if pausedUntil > now then
  return {0, pausedUntil - now}
end

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
tokens = math.min(capacity, tokens + (now - ts) * refillPerMs)
local allowed = 0
local wait = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  wait = math.ceil((cost - tokens) / refillPerMs)
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refillPerMs) + 60000)
return {allowed, wait}
`;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export class AccountRateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(
    private readonly redis: Redis,
    opts: { perHour?: number; burst?: number; prefix?: string } = {},
  ) {
    const perHour = opts.perHour ?? DEFAULT_HOURLY_BUDGET;
    this.capacity = opts.burst ?? Math.max(1, Math.floor(perHour / 12));
    this.refillPerMs = perHour / 3_600_000;
    this.prefix = opts.prefix ?? "rl";
  }
  private readonly prefix: string;

  async take(accountId: string, lane: "default" | "live" = "default", cost = 1): Promise<RateLimitResult> {
    const key = `${this.prefix}:${lane}:${accountId}`;
    const pauseKey = `${this.prefix}:pause:${accountId}`;
    const res = (await this.redis.eval(LUA, 2, key, pauseKey, this.capacity, this.refillPerMs, Date.now(), cost)) as [number, number];
    return { allowed: res[0] === 1, retryAfterMs: res[1] };
  }

  /** Called when Meta answers with a rate-limit error: stop sending for this account. */
  async pause(accountId: string, ms: number): Promise<void> {
    const until = Date.now() + ms;
    await this.redis.set(`${this.prefix}:pause:${accountId}`, String(until), "PX", ms);
  }

  /** Estimated time to drain `queued` sends at the steady rate. */
  etaMs(queued: number): number {
    return Math.ceil(queued / this.refillPerMs);
  }
}
