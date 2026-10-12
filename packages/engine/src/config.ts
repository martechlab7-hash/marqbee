import { createHash } from "node:crypto";

export interface Config {
  databaseUrl: string;
  databaseServiceUrl: string;
  redisUrl: string;
  metaAppId: string;
  metaAppSecret: string;
  metaVerifyToken: string;
  metaGraphVersion: string;
  metaClient: "live" | "fake";
  tokenEncryptionKey: string;
  sessionSecret: string;
  publicApiUrl: string;
  publicWebUrl: string;
  apiPort: number;
  sendsPerHour: number;
  isProd: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProd = env.NODE_ENV === "production";
  // META_CLIENT=fake lets you deploy a demo before your Meta app is approved.
  const fakeMeta = env.META_CLIENT === "fake";
  const need = (k: string, devDefault: string, optionalWhenFake = false) => {
    const v = env[k];
    if (v) return v;
    if (isProd && !(optionalWhenFake && fakeMeta)) throw new Error(`${k} is required in production`);
    return devDefault;
  };
  return {
    databaseUrl: need("DATABASE_URL", "postgres://marqbee_app:marqbee_app@localhost:5432/marqbee"),
    databaseServiceUrl: need("DATABASE_SERVICE_URL", "postgres://marqbee_service:marqbee_service@localhost:5432/marqbee"),
    redisUrl: need("REDIS_URL", "redis://localhost:6379"),
    metaAppId: need("META_APP_ID", "dev-app-id", true),
    metaAppSecret: need("META_APP_SECRET", "dev-app-secret", true),
    metaVerifyToken: need("META_WEBHOOK_VERIFY_TOKEN", "dev-verify-token", true),
    metaGraphVersion: env.META_GRAPH_VERSION || "v23.0",
    metaClient: fakeMeta || (!isProd && !env.META_APP_SECRET) ? "fake" : "live",
    // Dev fallback is a fixed, public key so the API and worker agree. Production refuses to start without a real one.
    tokenEncryptionKey: need("TOKEN_ENCRYPTION_KEY", DEV_KEY),
    sessionSecret: need("SESSION_SECRET", "dev-session-secret"),
    publicApiUrl: env.PUBLIC_API_URL || "http://localhost:4000",
    publicWebUrl: env.PUBLIC_WEB_URL || "http://localhost:3000",
    apiPort: Number(env.API_PORT || 4000),
    sendsPerHour: Number(env.SENDS_PER_HOUR || 600),
    isProd,
  };
}

const DEV_KEY = createHash("sha256").update("marqbee-insecure-dev-key").digest("base64");
