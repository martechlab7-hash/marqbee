import type { NextConfig } from "next";

const API = process.env.API_INTERNAL_URL || process.env.PUBLIC_API_URL || "http://localhost:4000";
if (process.env.VERCEL && API.includes("localhost")) {
  throw new Error("Set PUBLIC_API_URL in Vercel → Settings → Environment Variables to your API's URL (e.g. https://marqbee-api.onrender.com)");
}

// The dashboard talks to the API through same-origin rewrites, so the session
// cookie stays first-party and SameSite=Lax works without CORS.
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API}/api/:path*` },
      { source: "/auth/:path*", destination: `${API}/auth/:path*` },
      { source: "/r/:code", destination: `${API}/r/:code` },
      { source: "/b/:id", destination: `${API}/b/:id` },
      { source: "/public/:path*", destination: `${API}/public/:path*` },
    ];
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
