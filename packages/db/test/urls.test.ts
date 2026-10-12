import { describe, expect, it } from "vitest";
import { normalizeDbUrl, pgRoleName, resolveDatabaseUrls } from "../src/index.js";

const REF = "abcdefghijklmnopqrst";
// Shapes set by the Vercel ↔ Supabase integration.
const SUPA_POOLED = `postgres://postgres.${REF}:p%40ss@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x`;
const SUPA_SESSION = `postgres://postgres.${REF}:p%40ss@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require`;

describe("normalizeDbUrl", () => {
  it("strips provider-only params, keeps TLS, detects transaction pooling", () => {
    const n = normalizeDbUrl(SUPA_POOLED);
    expect(n.url).not.toContain("supa=");
    expect(n.url).not.toContain("sslmode");
    expect(n).toMatchObject({ ssl: "require", pooled: true });
    expect(normalizeDbUrl("postgres://u:p@db.example.com:5432/x?pgbouncer=true").pooled).toBe(true);
    expect(normalizeDbUrl("postgres://u:p@localhost:5432/x")).toMatchObject({ ssl: false, pooled: false });
    // Managed hosts get TLS even if the URL forgot sslmode.
    expect(normalizeDbUrl(`postgres://postgres:p@db.${REF}.supabase.co:5432/postgres`).ssl).toBe("require");
  });
});

describe("pgRoleName", () => {
  it("drops the Supavisor project suffix", () => {
    expect(pgRoleName(`postgres.${REF}`)).toBe("postgres");
    expect(pgRoleName(`marqbee_app.${REF}`)).toBe("marqbee_app");
    expect(pgRoleName("marqbee_app")).toBe("marqbee_app");
  });
});

describe("resolveDatabaseUrls", () => {
  it("Vercel Supabase integration: pooled runtime, session-mode migrations, derived app role", () => {
    const r = resolveDatabaseUrls({ POSTGRES_URL: SUPA_POOLED, POSTGRES_URL_NON_POOLING: SUPA_SESSION, DATABASE_APP_PASSWORD: "s3cr€t" });
    expect(r.service).toBe(SUPA_POOLED);
    expect(r.migrate).toBe(SUPA_SESSION);
    const app = new URL(r.app!);
    expect(app.username).toBe(`marqbee_app.${REF}`);
    expect(decodeURIComponent(app.password)).toBe("s3cr€t");
    expect(app.port).toBe("6543");
  });
  it("manually pasted Supabase DATABASE_URL works the same", () => {
    const r = resolveDatabaseUrls({ DATABASE_URL: SUPA_POOLED, DATABASE_APP_PASSWORD: "x" });
    expect(new URL(r.app!).username).toBe(`marqbee_app.${REF}`);
  });
  it("explicit two-URL setup is untouched; nothing resolved without an app password", () => {
    expect(resolveDatabaseUrls({ DATABASE_SERVICE_URL: "postgres://s@h/d", DATABASE_URL: "postgres://a@h/d" })).toEqual({
      service: "postgres://s@h/d",
      app: "postgres://a@h/d",
      migrate: "postgres://s@h/d",
    });
    expect(resolveDatabaseUrls({ POSTGRES_URL: SUPA_POOLED })).toEqual({});
  });
});
