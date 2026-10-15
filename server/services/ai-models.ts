/**
 * Resolves which Azure deployment an AI operation runs on for a given author.
 *
 * Each author can pick a model per operation in Settings (stored on their
 * user-settings document as `aiModels`). The picks are short keys (`luna`,
 * `terra`, `sol`) that map onto the configured chat tiers, so the deployment
 * names stay an environment concern.
 */
import config from '../config';
import { getContainer } from './cosmos';
import {
  AiModelKey,
  AiModelSettings,
  AiOperation,
  isAiModelKey,
  isAiModelSettings,
  modelKeyFor,
} from '../../shared/models/ai-model.model';

/** Who the request is for. Background work only knows the owner's email. */
export interface AiModelUser {
  sub?: string;
  email?: string;
}

/** Short enough that a change in Settings is picked up almost immediately. */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { settings: AiModelSettings; expires: number }>();

/** The Azure deployment a model key runs on. */
export function deploymentFor(key: AiModelKey): string {
  switch (key) {
    case 'sol':
      return config.foundry.highModel;
    case 'terra':
      return config.foundry.midModel;
    case 'luna':
    default:
      return config.foundry.lowModel;
  }
}

/** Drops cached picks so the next call re-reads them, e.g. after a settings save. */
export function invalidateAiModelSettings(user?: AiModelUser): void {
  if (!user) {
    cache.clear();
    return;
  }
  if (user.sub) cache.delete(`sub:${user.sub}`);
  if (user.email) cache.delete(`email:${user.email}`);
}

async function readAiModelSettings(user: AiModelUser): Promise<AiModelSettings> {
  const cacheKey = user.sub ? `sub:${user.sub}` : `email:${user.email}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.settings;

  let stored: unknown;
  try {
    const container = getContainer('user-settings');
    if (user.sub) {
      const { resource } = await container.item(user.sub, user.sub).read<{ aiModels?: unknown }>();
      stored = resource?.aiModels;
    } else {
      const { resources } = await container.items
        .query<{ aiModels?: unknown }>({
          query: 'SELECT c.aiModels FROM c WHERE c.email = @email',
          parameters: [{ name: '@email', value: user.email! }],
        })
        .fetchAll();
      stored = resources[0]?.aiModels;
    }
  } catch {
    // No settings yet (404) or the lookup failed — fall back to the defaults
    // rather than failing the AI call over a preference.
  }

  const settings = isAiModelSettings(stored) ? stored : {};
  cache.set(cacheKey, { settings, expires: Date.now() + CACHE_TTL_MS });
  return settings;
}

/** The deployment `op` runs on for this author: their pick, else the operation's default. */
export async function modelFor(user: AiModelUser | undefined, op: AiOperation): Promise<string> {
  const settings = user && (user.sub || user.email) ? await readAiModelSettings(user) : undefined;
  return deploymentFor(modelKeyFor(settings, op));
}

/**
 * The deployment for a chat turn: the model picked in the chat when it sent a
 * valid one, otherwise the author's chat setting.
 */
export async function chatModelFor(user: AiModelUser | undefined, requested: unknown): Promise<string> {
  if (isAiModelKey(requested)) return deploymentFor(requested);
  return modelFor(user, 'chat');
}
