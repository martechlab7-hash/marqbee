import type { NextConfig } from "next";

/**
 * Two deployment modes:
 *  - Single Vercel project (default): the API runs in-process via route handlers (lib/backend.ts).
 *  - Split: set API_INTERNAL_URL to a separately hosted API (e.g. Render) and these rewrites proxy to it.
 */
const EXTERNAL_API = process.env.API_INTERNAL_URL;
const PROXIED = ["/api/:path*", "/auth/:path*", "/webhooks/:path*", "/oauth/:path*", "/meta/:path*", "/internal/:path*", "/public/:path*", "/r/:code", "/b/:id", "/health"];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@marqbee/api", "@marqbee/engine", "@marqbee/core", "@marqbee/db"],
  serverExternalPackages: ["fastify", "@fastify/cookie", "@fastify/cors", "@fastify/formbody", "bullmq", "ioredis", "postgres", "pino", "@upstash/qstash"],
  webpack(config) {
    // Workspace packages use NodeNext-style ".js" imports of ".ts" files.
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
  async rewrites() {
    if (!EXTERNAL_API) return [];
    return { beforeFiles: PROXIED.map((source) => ({ source, destination: `${EXTERNAL_API}${source}` })), afterFiles: [], fallback: [] };
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
export default config;
