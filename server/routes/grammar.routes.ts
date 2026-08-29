import { Router, Request, Response } from 'express';
import { AzureOpenAI } from 'openai';
import config from '../config';

const router = Router();

const client = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: config.foundry.apiVersion,
});

interface GrammarError {
  text: string;
  suggestion: string;
  message: string;
}

interface SuggestedEntity {
  name: string;
  type: 'PERSON' | 'PLACE' | 'THING';
  description: string;
  firstName?: string;
  lastName?: string;
  nickname?: string;
  title?: string;
}

const SYSTEM_PROMPT = `You are a grammar checker and story analyst for fiction writing.
Analyze the provided text and return a JSON object with exactly two keys:

1. "errors": an array of clear grammar or punctuation mistakes. Each item must have:
   - "text": the exact verbatim substring from the input (character-for-character match, including case)
   - "suggestion": the corrected replacement for that exact substring
   - "message": a brief label (e.g. "Subject-verb agreement", "Missing comma")

2. "suggestedEntities": proper nouns found in the text that do NOT appear in the provided Known Entities list. Each item must have:
   - "name": the character's full name — first and last name only, never include a title or nickname in this field
   - "type": "PERSON", "PLACE", or "THING"
   - "description": one sentence describing what is known about them from the text
   For PERSON entities only, include any of the following fields ONLY when they can be clearly inferred from the text — do not guess or fabricate:
   - "firstName": given name, only if clearly stated or strongly implied
   - "lastName": family name, only if clearly stated or strongly implied
   - "nickname": an informal name or alias used in the text, only if explicitly present
   - "title": an honorific or rank (e.g. "Dr.", "Captain", "Lord"), only if explicitly present
   Omit a field entirely rather than guessing. Never put a title or nickname into the "name" field.

Rules:
- In "errors": only flag clear grammatical or punctuation mistakes. Do not flag proper nouns, intentional stylistic fragments, or dialogue punctuation.
- In "suggestedEntities": only include narratively significant names that clearly refer to specific characters, locations, or objects. Exclude common words, pronouns, and titles.
- The "text" in errors must be an exact substring present in the input.
- If nothing found, return empty arrays for both keys.
- Respond only with the raw JSON object, no markdown or code blocks.`;

router.post('/check', async (req: Request, res: Response) => {
  const { text, knownEntityNames } = req.body as { text?: string; knownEntityNames?: string[] };
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    res.status(400).json({ error: 'text required' });
    return;
  }

  // Limit input to avoid excessive token usage
  const trimmedText = text.slice(0, 8000);
  const entityList = Array.isArray(knownEntityNames) ? knownEntityNames.filter(n => typeof n === 'string') : [];

  const userContent = entityList.length > 0
    ? `Known entities (do not suggest these): ${entityList.join(', ')}\n\nText:\n${trimmedText}`
    : trimmedText;

  try {
    const completion = await client.chat.completions.create({
      model: config.foundry.midModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0]?.message?.content ?? '{"errors":[],"suggestedEntities":[]}';
    let errors: GrammarError[] = [];
    let suggestedEntities: SuggestedEntity[] = [];
    try {
      const parsed = JSON.parse(raw) as { errors?: unknown; suggestedEntities?: unknown };
      if (Array.isArray(parsed.errors)) {
        errors = (parsed.errors as GrammarError[]).filter(
          e =>
            e &&
            typeof e.text === 'string' &&
            typeof e.suggestion === 'string' &&
            typeof e.message === 'string' &&
            e.text.length > 0 &&
            trimmedText.includes(e.text),
        );
      }
      if (Array.isArray(parsed.suggestedEntities)) {
        suggestedEntities = (parsed.suggestedEntities as SuggestedEntity[]).filter(
          e =>
            e &&
            typeof e.name === 'string' &&
            typeof e.type === 'string' &&
            typeof e.description === 'string' &&
            ['PERSON', 'PLACE', 'THING'].includes(e.type),
        ).map(e => ({
          name: e.name,
          type: e.type,
          description: e.description,
          ...(e.firstName && typeof e.firstName === 'string' ? { firstName: e.firstName } : {}),
          ...(e.lastName && typeof e.lastName === 'string' ? { lastName: e.lastName } : {}),
          ...(e.nickname && typeof e.nickname === 'string' ? { nickname: e.nickname } : {}),
          ...(e.title && typeof e.title === 'string' ? { title: e.title } : {}),
        }));
      }
    } catch {
      errors = [];
      suggestedEntities = [];
    }

    res.json({ errors, suggestedEntities });
  } catch (err) {
    console.error('Grammar check error:', err);
    res.status(500).json({ errors: [], suggestedEntities: [] });
  }
});

export default router;
