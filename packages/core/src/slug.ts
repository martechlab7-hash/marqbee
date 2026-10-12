const RESERVED = new Set(["app", "api", "login", "signup", "admin", "r", "b", "privacy", "terms", "static", "_next", "webhooks", "oauth", "meta"]);

export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_.-]{1,39}$/.test(slug) && !RESERVED.has(slug);
}
