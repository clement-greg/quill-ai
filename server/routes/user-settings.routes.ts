import { Router, Request, Response } from 'express';
import { getContainer } from '../services/cosmos';
import { invalidateAiModelSettings } from '../services/ai-models';
import { AiModelSettings, isAiModelSettings } from '../../shared/models/ai-model.model';

const router = Router();

interface UserSettings {
  id: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
  avatarVideoUrl?: string;
  darkMode?: boolean;
  colorTheme?: string;
  editorFontSize?: string;
  editorFontFamily?: string;
  ghostCompleteItems?: { id: string; label: string; prompt: string }[];
  genderOptions?: string[];
  raceOptions?: string[];
  orientationOptions?: string[];
  grammarCheckEnabled?: boolean;
  entityDetectionEnabled?: boolean;
  autoSaveEnabled?: boolean;
  /** Model picked per AI operation; unset operations use their default. */
  aiModels?: AiModelSettings;
  pinHash?: string;
}

type SettingsField = Exclude<keyof UserSettings, 'id' | 'email'>;

const isString = (v: unknown) => typeof v === 'string';
const isBoolean = (v: unknown) => typeof v === 'boolean';
const isStringArray = (v: unknown) => Array.isArray(v) && v.every(isString);
const isGhostCompleteItems = (v: unknown) =>
  Array.isArray(v) &&
  v.every(item => item && isString(item.id) && isString(item.label) && isString(item.prompt));

// Fields a client may write, each with its type check. Fields absent from the
// request body keep their stored value, so a partial PUT never wipes data
// (e.g. pinHash, which the web client never sends).
const FIELD_VALIDATORS: Record<SettingsField, (v: unknown) => boolean> = {
  displayName: isString,
  avatarUrl: isString,
  avatarVideoUrl: isString,
  darkMode: isBoolean,
  colorTheme: isString,
  editorFontSize: isString,
  editorFontFamily: isString,
  ghostCompleteItems: isGhostCompleteItems,
  genderOptions: isStringArray,
  raceOptions: isStringArray,
  orientationOptions: isStringArray,
  grammarCheckEnabled: isBoolean,
  entityDetectionEnabled: isBoolean,
  autoSaveEnabled: isBoolean,
  aiModels: isAiModelSettings,
  pinHash: isString,
};

async function readSettings(sub: string): Promise<UserSettings | undefined> {
  const container = getContainer('user-settings');
  try {
    const { resource } = await container.item(sub, sub).read<UserSettings>();
    return resource;
  } catch (err: any) {
    if (err.code === 404) return undefined;
    throw err;
  }
}

// GET /api/user-settings
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const container = getContainer('user-settings');
    const { resource } = await container.item(user.sub, user.sub).read<UserSettings>();
    if (!resource) {
      res.json({});
      return;
    }
    const { id: _id, ...settings } = resource;
    res.json(settings);
  } catch (err: any) {
    if (err.code === 404) {
      res.json({});
      return;
    }
    console.error('[user-settings] GET error:', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// PUT /api/user-settings
router.put('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const updates: Partial<UserSettings> = {};
    const invalid: string[] = [];
    for (const [field, isValid] of Object.entries(FIELD_VALIDATORS) as [SettingsField, (v: unknown) => boolean][]) {
      if (body[field] === undefined) continue;
      if (isValid(body[field])) (updates as Record<string, unknown>)[field] = body[field];
      else invalid.push(field);
    }
    if (invalid.length) {
      res.status(400).json({ error: `Invalid settings fields: ${invalid.join(', ')}` });
      return;
    }

    const existing = await readSettings(user.sub);
    const settings: UserSettings = {
      ...existing,
      ...updates,
      id: user.sub,
      email: user.email,
    };
    await getContainer('user-settings').items.upsert(settings);
    if (updates.aiModels) invalidateAiModelSettings({ sub: user.sub, email: user.email });
    const { id: _id, ...result } = settings;
    res.json(result);
  } catch (err) {
    console.error('[user-settings] PUT error:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

export default router;
