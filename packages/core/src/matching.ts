/** Trigger matching for comment and DM keyword automations. */

export type MatchMode = "any" | "contains" | "exact";

export interface KeywordTrigger {
  mode: MatchMode;
  keywords: string[];
}

export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ")
    .replace(/[^\p{L}\p{N}\s#@]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Returns the keyword that matched, "*" for an any-text trigger, or null. */
export function matchKeyword(text: string, trigger: KeywordTrigger): string | null {
  if (trigger.mode === "any") return "*";
  const hay = normalizeText(text);
  if (!hay) return null;
  for (const raw of trigger.keywords) {
    const kw = normalizeText(raw);
    if (!kw) continue;
    if (trigger.mode === "exact" && hay === kw) return raw;
    if (trigger.mode === "contains") {
      // Whole-word match so "LINK" doesn't fire on "linked".
      const re = new RegExp(`(^|\\s)${escapeRegExp(kw)}(\\s|$)`, "u");
      if (re.test(hay)) return raw;
    }
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Picks a public reply variant. Rotation is deterministic per comment so a
 * retried job picks the same text, but spreads across variants overall.
 */
export function pickVariant(variants: string[], seed: string): string | undefined {
  const clean = variants.map((v) => v.trim()).filter(Boolean);
  if (clean.length === 0) return undefined;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return clean[(h >>> 0) % clean.length];
}

/** Replace {{username}}-style placeholders. Unknown keys render empty. */
export function renderTemplate(tpl: string, vars: Record<string, string | undefined>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}
