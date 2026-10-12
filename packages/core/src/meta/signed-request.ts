import { createHmac, timingSafeEqual } from "node:crypto";

/** Parses the signed_request Meta posts to the deauthorize and data-deletion callbacks. */
export function parseSignedRequest(signedRequest: string, appSecret: string): { user_id: string; algorithm: string; issued_at?: number } | null {
  const [sig, payload] = signedRequest.split(".", 2);
  if (!sig || !payload) return null;
  const expected = createHmac("sha256", appSecret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.algorithm?.toUpperCase() !== "HMAC-SHA256" || !data.user_id) return null;
    return { ...data, user_id: String(data.user_id) };
  } catch {
    return null;
  }
}

export function makeSignedRequest(data: Record<string, unknown>, appSecret: string): string {
  const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", ...data })).toString("base64url");
  const sig = createHmac("sha256", appSecret).update(payload).digest("base64url");
  return `${sig}.${payload}`;
}
