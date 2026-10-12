import { MetaApiError } from "./errors.js";

export const IG_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
] as const;

export function buildAuthorizeUrl(opts: { appId: string; redirectUri: string; state: string }): string {
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.searchParams.set("client_id", opts.appId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", IG_SCOPES.join(","));
  u.searchParams.set("state", opts.state);
  return u.toString();
}

export interface LongLivedToken {
  accessToken: string;
  expiresAt: Date;
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number }; error_message?: string };
  if (!res.ok || body.error) throw new MetaApiError(res.status, body.error ?? { message: body.error_message });
  return body;
}

/** code → short-lived token → long-lived (60 day) token. */
export async function exchangeCode(
  opts: { appId: string; appSecret: string; redirectUri: string; code: string; graphVersion: string },
  fetchImpl: typeof fetch = fetch,
): Promise<LongLivedToken & { igUserId: string }> {
  const form = new URLSearchParams({
    client_id: opts.appId,
    client_secret: opts.appSecret,
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri,
    code: opts.code,
  });
  const short = await json<{ access_token: string; user_id: string | number }>(
    await fetchImpl("https://api.instagram.com/oauth/access_token", { method: "POST", body: form }),
  );
  const u = new URL(`https://graph.instagram.com/access_token`);
  u.searchParams.set("grant_type", "ig_exchange_token");
  u.searchParams.set("client_secret", opts.appSecret);
  u.searchParams.set("access_token", short.access_token);
  const long = await json<{ access_token: string; expires_in: number }>(await fetchImpl(u));
  return { accessToken: long.access_token, expiresAt: new Date(Date.now() + long.expires_in * 1000), igUserId: String(short.user_id) };
}

export async function refreshLongLivedToken(token: string, fetchImpl: typeof fetch = fetch): Promise<LongLivedToken> {
  const u = new URL("https://graph.instagram.com/refresh_access_token");
  u.searchParams.set("grant_type", "ig_refresh_token");
  u.searchParams.set("access_token", token);
  const r = await json<{ access_token: string; expires_in: number }>(await fetchImpl(u));
  return { accessToken: r.access_token, expiresAt: new Date(Date.now() + r.expires_in * 1000) };
}
