/**
 * Owner-only configuration diagnostics.
 *
 * Exists because a misconfigured model deployment is invisible from outside:
 * every AI route reports it as "AI error occurred", and reading App Service
 * settings needs Azure RBAC that the app's own operator may not have. This
 * reports what the running process actually resolved.
 *
 * Reports presence and non-secret identifiers only — never a key or its length,
 * since a length narrows a brute force.
 */
import { Request, Response, Router } from 'express';
import { AzureOpenAI } from 'openai';
import config from '../config';

const router = Router();

/** Host of a URL, or a marker for absent/unparseable values. */
function hostOf(url: string | undefined): string {
  if (!url) return '(unset)';
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable)';
  }
}

/** GET the resolved AI configuration: what is set, and what it resolved to. */
router.get('/config', (_req: Request, res: Response) => {
  const { foundry, googleAIStudio } = config;
  res.json({
    foundry: {
      endpointHost: hostOf(foundry.endpoint),
      keyConfigured: !!foundry.key,
      apiVersion: foundry.apiVersion,
      embeddingModel: foundry.embeddingModel || '(unset)',
      tiers: {
        low: foundry.lowModel || '(unset)',
        mid: foundry.midModel || '(unset)',
        high: foundry.highModel || '(unset)',
      },
      // Which tier names came from the environment rather than the defaults.
      tiersFromEnv: {
        low: !!process.env['FOUNDRY_LOW_MODEL'],
        mid: !!process.env['FOUNDRY_MID_MODEL'],
        high: !!process.env['FOUNDRY_HIGH_MODEL'],
      },
    },
    googleAIStudio: { apiKeyConfigured: !!googleAIStudio?.apiKey },
  });
});

/**
 * POST a one-token completion to each chat tier and report what came back.
 * Turns "AI error occurred" into the actual status and message per tier.
 */
router.post('/chat-tiers', async (_req: Request, res: Response) => {
  const client = new AzureOpenAI({
    endpoint: config.foundry.endpoint,
    apiKey: config.foundry.key,
    apiVersion: config.foundry.apiVersion,
  });

  const tiers = [
    ['low', config.foundry.lowModel],
    ['mid', config.foundry.midModel],
    ['high', config.foundry.highModel],
  ] as const;

  const results: Record<string, unknown> = {};
  for (const [tier, model] of tiers) {
    try {
      const completion = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_completion_tokens: 16,
      });
      results[tier] = {
        deployment: model,
        ok: true,
        servedBy: completion.model,
      };
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      results[tier] = {
        deployment: model || '(unset)',
        ok: false,
        status: e.status ?? null,
        code: e.code ?? null,
        message: (e.message ?? String(err)).slice(0, 300),
      };
    }
  }

  res.json({ endpointHost: hostOf(config.foundry.endpoint), apiVersion: config.foundry.apiVersion, tiers: results });
});

export default router;
