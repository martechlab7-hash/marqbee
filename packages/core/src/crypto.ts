import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption for access tokens: each token gets a fresh data key,
 * which is wrapped by the master key. In production, swap `KeyWrapper` for
 * an AWS KMS implementation (GenerateDataKey / Decrypt) — the stored format
 * stays the same.
 */
export interface KeyWrapper {
  wrap(dataKey: Buffer): Promise<string>;
  unwrap(wrapped: string): Promise<Buffer>;
}

export class LocalKeyWrapper implements KeyWrapper {
  private readonly master: Buffer;
  constructor(masterKeyBase64: string) {
    this.master = Buffer.from(masterKeyBase64, "base64");
    if (this.master.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  async wrap(dataKey: Buffer): Promise<string> {
    return "local:" + aesGcmEncrypt(this.master, dataKey);
  }
  async unwrap(wrapped: string): Promise<Buffer> {
    if (!wrapped.startsWith("local:")) throw new Error("unknown key wrapper");
    return aesGcmDecrypt(this.master, wrapped.slice(6));
  }
}

function aesGcmEncrypt(key: Buffer, plain: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}

function aesGcmDecrypt(key: Buffer, blob: string): Buffer {
  const [iv, tag, ct] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !ct) throw new Error("malformed ciphertext");
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export class TokenVault {
  constructor(private readonly wrapper: KeyWrapper) {}

  async encrypt(token: string): Promise<string> {
    const dataKey = randomBytes(32);
    const wrapped = await this.wrapper.wrap(dataKey);
    return JSON.stringify({ v: 1, k: wrapped, c: aesGcmEncrypt(dataKey, Buffer.from(token, "utf8")) });
  }

  async decrypt(stored: string): Promise<string> {
    const env = JSON.parse(stored) as { v: number; k: string; c: string };
    if (env.v !== 1) throw new Error("unsupported token envelope");
    const dataKey = await this.wrapper.unwrap(env.k);
    return aesGcmDecrypt(dataKey, env.c).toString("utf8");
  }
}
