/** SA access: whether the caller is an SA, and (SA only) managing who else is. */
import { Router, Request, Response } from 'express';
import { getContainer } from '../services/cosmos';
import { addSaEmail, getSaEmails, isSa, normalizeEmail, removeSaEmail, requireSa } from '../services/sa-access';
import { KnownUser, SaMeResponse, SaUsersResponse } from '../../shared/models/sa-access.model';

const router = Router();

// GET /api/sa/me
router.get('/me', async (req: Request, res: Response): Promise<void> => {
  try {
    const body: SaMeResponse = { isSa: await isSa(req.user?.email) };
    res.json(body);
  } catch (err) {
    console.error('[sa] GET me error:', err);
    res.status(500).json({ error: 'Could not check access' });
  }
});

router.use('/users', requireSa);

/** Everyone who has saved settings — i.e. has signed in — for the "grant access" picker. */
async function listKnownUsers(): Promise<KnownUser[]> {
  const { resources } = await getContainer('user-settings').items
    .query<{ email?: string; displayName?: string }>('SELECT c.email, c.displayName FROM c')
    .fetchAll();
  const byEmail = new Map<string, KnownUser>();
  for (const u of resources) {
    if (!u.email) continue;
    const email = normalizeEmail(u.email);
    if (!byEmail.has(email)) byEmail.set(email, { email, displayName: u.displayName || undefined });
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

async function usersResponse(emails: string[]): Promise<SaUsersResponse> {
  return { emails, knownUsers: await listKnownUsers() };
}

function sendError(res: Response, err: any, fallback: string): void {
  if (err?.status === 400) {
    res.status(400).json({ error: err.message });
    return;
  }
  console.error(`[sa] ${fallback}:`, err);
  res.status(500).json({ error: fallback });
}

// GET /api/sa/users
router.get('/users', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(await usersResponse(await getSaEmails()));
  } catch (err) {
    sendError(res, err, 'Failed to load SA users');
  }
});

// POST /api/sa/users { email }
router.post('/users', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body ?? {};
  if (typeof email !== 'string') {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  try {
    res.json(await usersResponse(await addSaEmail(email, req.user!.email)));
  } catch (err) {
    sendError(res, err, 'Failed to grant SA access');
  }
});

// DELETE /api/sa/users/:email
router.delete('/users/:email', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await usersResponse(await removeSaEmail(String(req.params['email']), req.user!.email)));
  } catch (err) {
    sendError(res, err, 'Failed to remove SA access');
  }
});

export default router;
