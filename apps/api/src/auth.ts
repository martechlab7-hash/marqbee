import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { withTenant, type Role, type Tx } from "@marqbee/db";
import type { Deps } from "./app.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = "mqb_session";
const SESSION_DAYS = 30;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), expected.length, SCRYPT);
  return timingSafeEqual(got, expected);
}

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export interface AuthCtx {
  userId: string;
  workspaceId: string;
  role: Role;
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthCtx;
    /** Run queries as the RLS-restricted app role, scoped to the caller's workspace. */
    tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  }
}

export async function createSession(deps: Deps, reply: FastifyReply, userId: string, workspaceId: string) {
  const token = randomBytes(32).toString("base64url");
  await deps.engine.db`insert into sessions (id, user_id, workspace_id, expires_at)
    values (${hashToken(token)}, ${userId}, ${workspaceId}, now() + ${`${SESSION_DAYS} days`}::interval)`;
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: deps.engine.config.isProd,
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function destroySession(deps: Deps, req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await deps.engine.db`delete from sessions where id = ${hashToken(token)}`;
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function registerAuth(app: FastifyInstance, deps: Deps) {
  app.decorateRequest("auth", undefined);
  app.decorateRequest("tx", function <T>(this: FastifyRequest, fn: (tx: Tx) => Promise<T>) {
    if (!this.auth) throw Object.assign(new Error("unauthenticated"), { statusCode: 401 });
    return withTenant(deps.appDb, this.auth.workspaceId, fn);
  });

  app.addHook("onRequest", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const [s] = await deps.engine.db<{ id: string; user_id: string; workspace_id: string; role: Role }[]>`
      select s.id, s.user_id, s.workspace_id, m.role from sessions s
      join memberships m on m.user_id = s.user_id and m.workspace_id = s.workspace_id
      where s.id = ${hashToken(token)} and s.expires_at > now()`;
    if (s) req.auth = { userId: s.user_id, workspaceId: s.workspace_id, role: s.role, sessionId: s.id };
  });

  // CSRF: SameSite=Lax cookies + mutations must come from our own web origin.
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin && !deps.engine.config.allowedOrigins.includes(origin)) {
      return reply.status(403).send({ error: "bad_origin" });
    }
  });
}

const RANK: Record<Role, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 };

/** preHandler: require a session with at least `min` role. */
export function requireRole(min: Role) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.auth) return reply.status(401).send({ error: "unauthenticated" });
    if (RANK[req.auth.role] < RANK[min]) return reply.status(403).send({ error: "forbidden" });
  };
}

export async function audit(tx: Tx, req: FastifyRequest, action: string, entity: string, entityId: string | null, diff: unknown = {}) {
  await tx`insert into audit_log (workspace_id, user_id, action, entity, entity_id, diff)
           values (${req.auth!.workspaceId}, ${req.auth!.userId}, ${action}, ${entity}, ${entityId}, ${tx.json(diff as never)})`;
}
