import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { createSession, destroySession, hashPassword, verifyPassword } from "../auth.js";

const Signup = z.object({
  email: z.string().email().max(200).transform((s) => s.toLowerCase().trim()),
  password: z.string().min(10, "use at least 10 characters").max(200),
  name: z.string().max(100).optional(),
  workspaceName: z.string().max(100).optional(),
});
const Login = z.object({ email: z.string().transform((s) => s.toLowerCase().trim()), password: z.string() });

export const authRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps.engine;

    app.post("/auth/signup", async (req, reply) => {
      if (await tooMany(deps, `signup:${req.ip}`, 10)) return reply.status(429).send({ error: "Too many attempts, try again later" });
      const body = Signup.parse(req.body);
      const [exists] = await db`select 1 from users where email = ${body.email}`;
      if (exists) return reply.status(409).send({ error: "An account with this email already exists" });
      const hash = await hashPassword(body.password);
      const { userId, workspaceId } = await db.begin(async (tx) => {
        const [u] = await tx<{ id: string }[]>`insert into users (email, name, password_hash) values (${body.email}, ${body.name ?? null}, ${hash}) returning id`;
        const [w] = await tx<{ id: string }[]>`insert into workspaces (name) values (${body.workspaceName || body.name || body.email.split("@")[0]!}) returning id`;
        await tx`insert into memberships (workspace_id, user_id, role) values (${w!.id}, ${u!.id}, 'owner')`;
        return { userId: u!.id, workspaceId: w!.id };
      });
      await createSession(deps, reply, userId, workspaceId);
      return { ok: true };
    });

    app.post("/auth/login", async (req, reply) => {
      const body = Login.parse(req.body);
      if (await tooMany(deps, `login:${req.ip}:${body.email}`, 10)) return reply.status(429).send({ error: "Too many attempts, try again later" });
      const [u] = await db<{ id: string; password_hash: string }[]>`select id, password_hash from users where email = ${body.email}`;
      // Constant-ish time: always run a hash even for unknown users.
      const ok = u ? await verifyPassword(body.password, u.password_hash) : (await hashPassword(body.password), false);
      if (!u || !ok) return reply.status(401).send({ error: "Wrong email or password" });
      const [m] = await db<{ workspace_id: string }[]>`select workspace_id from memberships where user_id = ${u.id} order by created_at limit 1`;
      if (!m) return reply.status(403).send({ error: "No workspace" });
      await createSession(deps, reply, u.id, m.workspace_id);
      return { ok: true };
    });

    app.post("/auth/logout", async (req, reply) => {
      await destroySession(deps, req, reply);
      return { ok: true };
    });

    app.get("/auth/me", async (req, reply) => {
      if (!req.auth) return reply.status(401).send({ error: "unauthenticated" });
      const [user] = await db`select id, email, name from users where id = ${req.auth.userId}`;
      const workspaces = await db`
        select w.id, w.name, w.plan, m.role from memberships m join workspaces w on w.id = m.workspace_id
        where m.user_id = ${req.auth.userId} order by w.created_at`;
      return { user, workspace: workspaces.find((w) => w.id === req.auth!.workspaceId), workspaces, metaMode: deps.engine.config.metaClient };
    });

    app.post("/auth/switch-workspace", async (req, reply) => {
      if (!req.auth) return reply.status(401).send({ error: "unauthenticated" });
      const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(req.body);
      const [m] = await db`select 1 from memberships where user_id = ${req.auth.userId} and workspace_id = ${workspaceId}`;
      if (!m) return reply.status(403).send({ error: "forbidden" });
      await db`update sessions set workspace_id = ${workspaceId} where id = ${req.auth.sessionId}`;
      return { ok: true };
    });
  };

/** Fixed-window attempt counter in Redis (10 minutes). */
async function tooMany(deps: Deps, key: string, max: number): Promise<boolean> {
  const k = `${deps.engine.prefix}:attempts:${key}`;
  const n = await deps.engine.redis.incr(k);
  if (n === 1) await deps.engine.redis.expire(k, 600);
  return n > max;
}
