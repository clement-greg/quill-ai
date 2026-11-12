/**
 * SA ("system administrator") access: a short list of emails allowed to use
 * app-wide admin features such as database backups. Any Google account can
 * sign in, so anything that touches every user's data sits behind this.
 *
 * The list is one document in app-settings. When it doesn't exist yet it is
 * created with BOOTSTRAP_SA_EMAILS, so the first administrator never needs a
 * manual database edit. After that the SA screen manages it, and it can never
 * be emptied (the last SA can't be removed, nor can anyone remove themselves).
 */
import { Request, Response, NextFunction } from 'express';
import { getContainer } from './cosmos';

const SA_DOC_ID = 'sa-users';
export const BOOTSTRAP_SA_EMAILS = ['gregbclement@gmail.com'];
const CACHE_MS = 60_000;

interface SaUsersDoc {
  id: string;
  emails: string[];
  updatedAt?: string;
  updatedBy?: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

let cache: { emails: string[]; at: number } | null = null;

export function invalidateSaCache(): void {
  cache = null;
}

export async function getSaEmails(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.emails;
  const container = getContainer('app-settings');
  const stored = await container.item(SA_DOC_ID, SA_DOC_ID).read<SaUsersDoc>()
    .then(r => r.resource ?? null)
    .catch((err: any) => { if (err.code === 404) return null; throw err; });
  let emails: string[];
  if (stored) {
    emails = stored.emails.map(normalizeEmail);
  } else {
    emails = BOOTSTRAP_SA_EMAILS.map(normalizeEmail);
    await container.items.create({ id: SA_DOC_ID, emails, updatedAt: new Date().toISOString(), updatedBy: 'bootstrap' })
      .catch((err: any) => { if (err.code !== 409) throw err; }); // another instance bootstrapped first
  }
  cache = { emails, at: Date.now() };
  return emails;
}

export async function isSa(email: string | undefined): Promise<boolean> {
  if (!email) return false;
  return (await getSaEmails()).includes(normalizeEmail(email));
}

async function saveSaEmails(emails: string[], by: string): Promise<string[]> {
  const doc: SaUsersDoc = { id: SA_DOC_ID, emails, updatedAt: new Date().toISOString(), updatedBy: by };
  await getContainer('app-settings').items.upsert(doc);
  cache = { emails, at: Date.now() };
  return emails;
}

export async function addSaEmail(email: string, by: string): Promise<string[]> {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) throw Object.assign(new Error('Not a valid email address'), { status: 400 });
  const current = await getSaEmails();
  if (current.includes(normalized)) return current;
  return saveSaEmails([...current, normalized].sort(), by);
}

export async function removeSaEmail(email: string, by: string): Promise<string[]> {
  const normalized = normalizeEmail(email);
  const current = await getSaEmails();
  if (!current.includes(normalized)) return current;
  if (normalized === normalizeEmail(by)) {
    throw Object.assign(new Error("You can't remove your own SA access"), { status: 400 });
  }
  if (current.length <= 1) {
    throw Object.assign(new Error("The last SA user can't be removed"), { status: 400 });
  }
  return saveSaEmails(current.filter(e => e !== normalized), by);
}

/** Express guard: 403 unless the signed-in user has SA access. Use after requireAuth. */
export async function requireSa(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (await isSa(req.user?.email)) {
      next();
      return;
    }
    res.status(403).json({ error: 'SA access required' });
  } catch (err) {
    console.error('[sa] access check failed:', err);
    res.status(500).json({ error: 'Could not check access' });
  }
}
