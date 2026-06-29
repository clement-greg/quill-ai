/**
 * Name-based entity matching shared by features that must turn a free-text name
 * (typically produced by the LLM) back into a concrete entity. Resolving by name
 * — rather than asking the model to echo an opaque id it can easily copy wrong —
 * keeps attributions honest: a name the model invented or mixed up simply fails
 * to resolve instead of silently landing on the wrong entity.
 */

/** Minimal shape needed to match an entity by any of its names. */
export interface NameMatchable {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  nickname?: string;
  title?: string;
  aliases?: string[];
}

/** Every name an entity can be referred to by, trimmed and non-empty. */
export function entityNameForms(e: NameMatchable): string[] {
  return [e.name, e.firstName, e.lastName, e.nickname, e.title,
    [e.firstName, e.lastName].filter(Boolean).join(' '), ...(e.aliases ?? [])]
    .map(s => (s ?? '').trim())
    .filter(Boolean);
}

/** Score how well an entity's name forms match a free-text name: 1 exact, 0.9 whole-word, 0 none. */
export function nameMatchScore(forms: string[], query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const wholeWord = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  let best = 0;
  for (const form of forms) {
    const f = form.toLowerCase();
    if (f === q) return 1;
    if (wholeWord.test(f)) best = Math.max(best, 0.9);
  }
  return best;
}

/**
 * Resolves a free-text entity name to a single candidate. Returns null when nothing
 * matches or when the best match is ambiguous (a name/alias shared by more than one
 * entity) — leaving the caller to drop the item rather than guess wrong.
 */
export function resolveEntityByName<T extends NameMatchable>(name: unknown, candidates: T[]): T | null {
  if (typeof name !== 'string' || !name.trim()) return null;
  let best: T | null = null;
  let bestScore = 0;
  let ambiguous = false;
  for (const e of candidates) {
    const score = nameMatchScore(entityNameForms(e), name);
    if (score > bestScore) {
      bestScore = score;
      best = e;
      ambiguous = false;
    } else if (score === bestScore && score > 0 && best && e.id !== best.id) {
      ambiguous = true;
    }
  }
  return bestScore === 0 || ambiguous ? null : best;
}
